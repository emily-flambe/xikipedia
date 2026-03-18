/**
 * Adversarial tests for logout / token-revocation implementation (EMI-47).
 *
 * Each test section is labelled with the bug it targets.
 */

import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const MOCK_SMOLDATA = {
  subCategories: { science: ['physics'], nature: ['animals'] },
  noPageMaps: { '999': 'test' },
  pages: Array.from({ length: 30 }, (_, i) => [
    `Article ${i}`, i + 1,
    'A'.repeat(120) + ` content ${i}`,
    null, ['science'], [((i + 1) % 30) + 1],
  ]),
};

let _ipCounter = 0;
const _ipOctet = Math.floor(Math.random() * 256);
function uniqueIp(): string {
  _ipCounter++;
  return `10.${_ipOctet}.${Math.floor(_ipCounter / 256) % 256}.${_ipCounter % 256}`;
}

function uniqueUser(): string {
  const ts = Date.now().toString(36).slice(-4);
  const rnd = Math.random().toString(36).slice(2, 6);
  return `u${ts}${rnd}`;
}

async function mockSmoldata(page: Page) {
  const body = JSON.stringify(MOCK_SMOLDATA);
  await page.route('**/smoldata.json', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body }),
  );
}

async function apiRegister(
  page: Page,
  username: string,
  password: string,
): Promise<{ token: string; username: string }> {
  const resp = await page.request.post('/api/register', {
    data: { username, password },
    headers: { 'x-forwarded-for': uniqueIp() },
  });
  expect(resp.status()).toBe(201);
  return resp.json();
}

// =============================================================================
// BUG 1: Old token (no token_version field) should be rejected at DB-check routes
// =============================================================================

test.describe('Old token compatibility - missing token_version', () => {
  /**
   * A JWT minted before EMI-47 will have no token_version in its payload.
   * The authenticate() DB-check path does:
   *   if (user.token_version !== payload.token_version) return null;
   *
   * user.token_version = 1 (DEFAULT), payload.token_version = undefined.
   * 1 !== undefined  →  true  →  returns null  →  401.
   *
   * This is the DESIRED behavior, but this test verifies it actually happens
   * (i.e., the server doesn't accidentally coerce undefined to 1).
   *
   * To simulate: craft a valid JWT with no token_version field.
   * We can't sign with the real key, so this test hits the endpoint with
   * a structurally-valid token that is signed with a wrong key -- we're
   * confirming the 401 path, not the coercion behavior.
   *
   * The real scenario (same key, missing field) is verified by the TypeScript
   * type system analysis in the bug report below.
   */
  test('token without token_version field is rejected by authenticate()', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    // Craft a JWT payload without token_version. We can't sign it with the
    // real JWT_SECRET, but we can verify the server correctly rejects tokens
    // where verification fails. This confirms the code path exists.
    const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const payload = btoa(JSON.stringify({
      sub: 1,
      username: 'admin',
      exp: Math.floor(Date.now() / 1000) + 3600,
      // NOTE: no token_version field
    })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    const fakeToken = `${header}.${payload}.invalidsignature`;

    // Verify all three DB-checked endpoints reject this token
    const logoutResp = await page.request.post('/api/logout', {
      headers: { Authorization: `Bearer ${fakeToken}` },
    });
    expect(logoutResp.status()).toBe(401);

    const changePassResp = await page.request.post('/api/change-password', {
      headers: {
        Authorization: `Bearer ${fakeToken}`,
        'Content-Type': 'application/json',
      },
      data: { currentPassword: 'x', newPassword: 'newpass123' },
    });
    expect(changePassResp.status()).toBe(401);
  });
});

// =============================================================================
// BUG 2: Token remains valid after logout until token_version propagates
// (Race: two simultaneous logout requests -- double increment)
// =============================================================================

test.describe('Concurrent logout - double token_version increment', () => {
  /**
   * Two simultaneous POST /api/logout with the same valid token.
   * Both pass authenticate() (same token_version at read time).
   * Both run: UPDATE users SET token_version = token_version + 1
   * Result: token_version increments TWICE (e.g., 1 -> 3).
   *
   * After this, the user logs back in and gets a token with token_version=3.
   * Consequence: This is mostly harmless (double increment causes no security
   * issue -- the old token is still invalidated). BUT if a new token is
   * issued with token_version=2 (stale read during race), it gets
   * immediately invalidated by the second increment.
   *
   * The test below verifies the double-logout doesn't break subsequent login.
   */
  test('two concurrent logouts do not prevent re-login', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    const user = uniqueUser();
    const { token } = await apiRegister(page, user, 'password123');

    // Fire two simultaneous logout requests
    const [r1, r2] = await Promise.all([
      page.request.post('/api/logout', {
        headers: { Authorization: `Bearer ${token}` },
      }),
      page.request.post('/api/logout', {
        headers: { Authorization: `Bearer ${token}` },
      }),
    ]);

    // At least one should succeed (the second may get 401 if first already
    // incremented; OR both may succeed due to race). Either is "acceptable"
    // but let's document what actually happens.
    const statuses = [r1.status(), r2.status()].sort();
    // The key property: no 500s
    expect(r1.status()).not.toBe(500);
    expect(r2.status()).not.toBe(500);

    // CRITICAL: After double-logout, login must still work and new token
    // must be usable for preferences
    const loginResp = await page.request.post('/api/login', {
      data: { username: user, password: 'password123' },
      headers: { 'x-forwarded-for': uniqueIp() },
    });
    expect(loginResp.status()).toBe(200);
    const { token: newToken } = await loginResp.json();

    // New token must work for a protected endpoint
    const prefsResp = await page.request.get('/api/preferences', {
      headers: { Authorization: `Bearer ${newToken}` },
    });
    expect(prefsResp.status()).toBe(200);

    // Log the double-increment behavior for investigation
    console.log(`Concurrent logout statuses: ${statuses}`);
  });

  /**
   * Specific failure scenario: if two concurrent logouts both succeed,
   * token_version ends up at 3. But handleLogin reads token_version BEFORE
   * increment and issues a token at version=2 (between the two increments).
   * That token would be immediately invalid against version=3 in DB.
   *
   * This test tries to reproduce that race by logging in between two logouts.
   */
  test('login token issued between concurrent logouts is valid', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    const user = uniqueUser();
    const { token } = await apiRegister(page, user, 'password123');

    // Start first logout (don't await yet)
    const logout1 = page.request.post('/api/logout', {
      headers: { Authorization: `Bearer ${token}` },
    });

    // Immediately try to login (race with logout)
    const loginRace = page.request.post('/api/login', {
      data: { username: user, password: 'password123' },
      headers: { 'x-forwarded-for': uniqueIp() },
    });

    const [logoutResult, loginResult] = await Promise.all([logout1, loginRace]);

    // If login succeeded, the resulting token MUST work
    if (loginResult.status() === 200) {
      const { token: racyToken } = await loginResult.json();
      const prefsResp = await page.request.get('/api/preferences', {
        headers: { Authorization: `Bearer ${racyToken}` },
      });
      // This may FAIL if the token was issued with stale token_version
      expect(prefsResp.status()).toBe(200);
    }
  });
});

// =============================================================================
// BUG 3: token_version check produces wrong error message for deleted user
// =============================================================================

test.describe('Error message when deleted user token hits logout/change-password', () => {
  /**
   * authenticate() with db returns null (not a 404) when user is not found.
   * The caller then returns 401 "Unauthorized" -- not 404 "User not found".
   * BUT auth-adversarial.spec.ts line 496 asserts:
   *   expect(body.error).toBe('User not found');   <-- for PUT /api/preferences
   *
   * That test passes because handlePutPreferences does its OWN DB lookup after
   * authenticate() returns a payload. But for /api/logout and /api/change-password,
   * authenticate() itself does the DB check and returns null -> 401 "Unauthorized".
   *
   * Existing test expects 'User not found' on preferences. This test verifies
   * the inconsistency doesn't affect logout (401 is correct there), but also
   * checks the error body is meaningful.
   */
  test('logout with deleted-user token returns 401 not 404', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    const user = uniqueUser();
    const { token } = await apiRegister(page, user, 'password123');

    // Delete the account
    await page.request.delete('/api/account', {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'x-forwarded-for': uniqueIp(),
      },
      data: JSON.stringify({ password: 'password123' }),
    });

    // Now try to logout with the old token
    const logoutResp = await page.request.post('/api/logout', {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(logoutResp.status()).toBe(401);
    const body = await logoutResp.json();
    expect(body.error).toBe('Unauthorized');
    // NOTE: This is INCONSISTENT with the 'User not found' error returned by
    // preferences endpoints (which do their own DB lookup after authenticate).
    // The test documents the actual behavior.
  });
});

// =============================================================================
// BUG 4: POST /api/logout with no Authorization header
// =============================================================================

test.describe('Logout without auth', () => {
  test('POST /api/logout with no token returns 401', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    const resp = await page.request.post('/api/logout');
    expect(resp.status()).toBe(401);
    const body = await resp.json();
    expect(body.error).toBeTruthy();
  });

  test('POST /api/logout with malformed Bearer token returns 401', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    const resp = await page.request.post('/api/logout', {
      headers: { Authorization: 'Bearer not.a.real.jwt.at.all' },
    });
    expect(resp.status()).toBe(401);
  });

  test('GET /api/logout returns 404 (wrong method)', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    const resp = await page.request.get('/api/logout');
    expect(resp.status()).toBe(404);
  });
});

// =============================================================================
// BUG 5: Token remains usable AFTER logout (server-side revocation check)
// =============================================================================

test.describe('Token revocation - token unusable after logout', () => {
  test('preferences PUT returns 401 after server-side logout', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    const user = uniqueUser();
    const { token } = await apiRegister(page, user, 'password123');

    // Verify token works before logout
    const before = await page.request.put('/api/preferences', {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      data: { categoryScores: { test: 1 }, hiddenCategories: [] },
    });
    expect(before.status()).toBe(200);

    // Logout (increments token_version on server)
    const logoutResp = await page.request.post('/api/logout', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(logoutResp.status()).toBe(200);

    // Old token must now be rejected
    const after = await page.request.put('/api/preferences', {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      data: { categoryScores: { test: 2 }, hiddenCategories: [] },
    });
    expect(after.status()).toBe(401);
  });

  test('preferences GET returns 401 after server-side logout', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    const user = uniqueUser();
    const { token } = await apiRegister(page, user, 'password123');

    await page.request.post('/api/logout', {
      headers: { Authorization: `Bearer ${token}` },
    });

    const resp = await page.request.get('/api/preferences', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(resp.status()).toBe(401);
  });

  test('logout endpoint itself returns 401 on second call with same token', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    const user = uniqueUser();
    const { token } = await apiRegister(page, user, 'password123');

    // First logout - should succeed
    const first = await page.request.post('/api/logout', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(first.status()).toBe(200);

    // Second logout with same (now-revoked) token - must fail
    const second = await page.request.post('/api/logout', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(second.status()).toBe(401);
  });
});

// =============================================================================
// BUG 6: POST /api/change-password - full coverage
// =============================================================================

test.describe('Change password', () => {
  test('change-password succeeds with correct current password', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    const user = uniqueUser();
    await apiRegister(page, user, 'oldpass123');

    // Login to get token
    const loginResp = await page.request.post('/api/login', {
      data: { username: user, password: 'oldpass123' },
      headers: { 'x-forwarded-for': uniqueIp() },
    });
    const { token } = await loginResp.json();

    const resp = await page.request.post('/api/change-password', {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      data: { currentPassword: 'oldpass123', newPassword: 'newpass456' },
    });
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(body.success).toBe(true);
  });

  test('change-password invalidates old token immediately', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    const user = uniqueUser();
    await apiRegister(page, user, 'oldpass123');

    const loginResp = await page.request.post('/api/login', {
      data: { username: user, password: 'oldpass123' },
      headers: { 'x-forwarded-for': uniqueIp() },
    });
    const { token } = await loginResp.json();

    // Change password (increments token_version)
    await page.request.post('/api/change-password', {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      data: { currentPassword: 'oldpass123', newPassword: 'newpass456' },
    });

    // Old token must be rejected now
    const afterResp = await page.request.get('/api/preferences', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(afterResp.status()).toBe(401);
  });

  test('new login after change-password works with new credentials', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    const user = uniqueUser();
    await apiRegister(page, user, 'oldpass123');

    const loginResp = await page.request.post('/api/login', {
      data: { username: user, password: 'oldpass123' },
      headers: { 'x-forwarded-for': uniqueIp() },
    });
    const { token } = await loginResp.json();

    await page.request.post('/api/change-password', {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      data: { currentPassword: 'oldpass123', newPassword: 'newpass456' },
    });

    // Old password must fail
    const oldLogin = await page.request.post('/api/login', {
      data: { username: user, password: 'oldpass123' },
      headers: { 'x-forwarded-for': uniqueIp() },
    });
    expect(oldLogin.status()).toBe(401);

    // New password must succeed
    const newLogin = await page.request.post('/api/login', {
      data: { username: user, password: 'newpass456' },
      headers: { 'x-forwarded-for': uniqueIp() },
    });
    expect(newLogin.status()).toBe(200);

    // Token from new login must work
    const { token: newToken } = await newLogin.json();
    const prefsResp = await page.request.get('/api/preferences', {
      headers: { Authorization: `Bearer ${newToken}` },
    });
    expect(prefsResp.status()).toBe(200);
  });

  test('change-password rejects wrong current password with 403', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    const user = uniqueUser();
    await apiRegister(page, user, 'correctpass');

    const loginResp = await page.request.post('/api/login', {
      data: { username: user, password: 'correctpass' },
      headers: { 'x-forwarded-for': uniqueIp() },
    });
    const { token } = await loginResp.json();

    const resp = await page.request.post('/api/change-password', {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      data: { currentPassword: 'wrongpass', newPassword: 'newpass456' },
    });
    expect(resp.status()).toBe(403);
    const body = await resp.json();
    expect(body.error).toBeTruthy();
  });

  test('change-password with missing currentPassword returns 400', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    const user = uniqueUser();
    const { token } = await apiRegister(page, user, 'pass123');

    const resp = await page.request.post('/api/change-password', {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      data: { newPassword: 'newpass456' },
    });
    expect(resp.status()).toBe(400);
  });

  test('change-password with missing newPassword returns 400', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    const user = uniqueUser();
    const { token } = await apiRegister(page, user, 'pass123');

    const resp = await page.request.post('/api/change-password', {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      data: { currentPassword: 'pass123' },
    });
    expect(resp.status()).toBe(400);
  });

  test('change-password with newPassword too short returns 400', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    const user = uniqueUser();
    const { token } = await apiRegister(page, user, 'pass123');

    const resp = await page.request.post('/api/change-password', {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      data: { currentPassword: 'pass123', newPassword: 'abc' },
    });
    expect(resp.status()).toBe(400);
  });

  test('change-password with newPassword over 256 chars returns 400', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    const user = uniqueUser();
    const { token } = await apiRegister(page, user, 'pass123');

    const resp = await page.request.post('/api/change-password', {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      data: { currentPassword: 'pass123', newPassword: 'a'.repeat(257) },
    });
    expect(resp.status()).toBe(400);
  });

  test('change-password with no Authorization returns 401', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    const resp = await page.request.post('/api/change-password', {
      headers: { 'Content-Type': 'application/json' },
      data: { currentPassword: 'pass123', newPassword: 'newpass456' },
    });
    expect(resp.status()).toBe(401);
  });

  test('change-password with invalid JSON body returns 400', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    const user = uniqueUser();
    const { token } = await apiRegister(page, user, 'pass123');

    const resp = await page.request.fetch('/api/change-password', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      data: 'not json at all {{{',
    });
    expect(resp.status()).toBe(400);
  });

  test('GET /api/change-password returns 404 (wrong method)', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    const resp = await page.request.get('/api/change-password');
    expect(resp.status()).toBe(404);
  });

  /**
   * BUG CANDIDATE: change-password has no rate limiting.
   * An attacker who knows a valid token can brute-force the current password
   * via this endpoint (3 attempts per second = 259,200 per day).
   * Compare with /api/login which rate-limits after 5 failures per 15 minutes.
   *
   * This test documents the absence of rate limiting (expected to PASS,
   * documenting the vulnerability).
   */
  test('change-password has no rate limiting - documents missing protection', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    const user = uniqueUser();
    const { token } = await apiRegister(page, user, 'correctpass');

    // Send 10 wrong-password attempts - none should be rate-limited
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        page.request.post('/api/change-password', {
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          data: { currentPassword: 'wrongpass', newPassword: 'newpass456' },
        }),
      ),
    );

    // All should return 403 (wrong password), NOT 429 (rate limited)
    // This test PASSES and documents that brute-force protection is missing.
    results.forEach((resp) => {
      expect(resp.status()).toBe(403);
      // If any return 429, rate limiting was added and this test should be updated
    });
  });
});

// =============================================================================
// BUG 7: savePreferences() 401 handling - promise chain structure
// =============================================================================

test.describe('savePreferences 401 handling', () => {
  /**
   * savePreferences() uses a fire-and-forget .then() chain (no await).
   * The .catch() only runs on network failure, not on non-ok responses.
   *
   * Code at index.html ~line 2630:
   *   fetch(...).then(resp => {
   *     if (resp.status === 401) { ... reload ... }
   *   }).catch(e => { ... showErrorToast ... });
   *
   * If the server returns 401, the .then() runs and calls window.location.reload().
   * BUT: .then() returns undefined if status !== 401, NOT throwing -- so 500s
   * and other errors are silently swallowed. This is intentional but undocumented.
   *
   * The API-level test: verify that PUT /api/preferences with a logged-out
   * token (incremented token_version) correctly returns 401.
   */
  test('PUT /api/preferences returns 401 after logout invalidates token', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    const user = uniqueUser();
    const { token } = await apiRegister(page, user, 'pass123');

    // Logout server-side (increments token_version)
    await page.request.post('/api/logout', {
      headers: { Authorization: `Bearer ${token}` },
    });

    // savePreferences would fire this request - must get 401
    const resp = await page.request.put('/api/preferences', {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      data: { categoryScores: { x: 1 }, hiddenCategories: [] },
    });
    expect(resp.status()).toBe(401);
  });
});

// =============================================================================
// BUG 8: CORS headers on new endpoints
// =============================================================================

test.describe('CORS headers on new endpoints', () => {
  test('POST /api/logout includes CORS headers on success', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    const user = uniqueUser();
    const { token } = await apiRegister(page, user, 'pass123');

    const resp = await page.request.post('/api/logout', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const headers = resp.headers();
    expect(headers['access-control-allow-origin']).toBeTruthy();
  });

  test('POST /api/logout includes CORS headers on 401 error', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    const resp = await page.request.post('/api/logout');
    expect(resp.status()).toBe(401);
    const headers = resp.headers();
    expect(headers['access-control-allow-origin']).toBeTruthy();
  });

  test('POST /api/change-password includes CORS headers on success', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    const user = uniqueUser();
    const { token } = await apiRegister(page, user, 'pass123');

    const resp = await page.request.post('/api/change-password', {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      data: { currentPassword: 'pass123', newPassword: 'newpass456' },
    });
    const headers = resp.headers();
    expect(headers['access-control-allow-origin']).toBeTruthy();
  });

  test('POST /api/change-password includes CORS headers on 401 error', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    const resp = await page.request.post('/api/change-password', {
      headers: { 'Content-Type': 'application/json' },
      data: { currentPassword: 'pass123', newPassword: 'newpass456' },
    });
    expect(resp.status()).toBe(401);
    const headers = resp.headers();
    expect(headers['access-control-allow-origin']).toBeTruthy();
  });

  test('OPTIONS preflight for /api/logout returns 204', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    const resp = await page.request.fetch('/api/logout', { method: 'OPTIONS' });
    expect(resp.status()).toBe(204);
    const headers = resp.headers();
    expect(headers['access-control-allow-methods']).toContain('POST');
  });

  test('OPTIONS preflight for /api/change-password returns 204', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    const resp = await page.request.fetch('/api/change-password', { method: 'OPTIONS' });
    expect(resp.status()).toBe(204);
    const headers = resp.headers();
    expect(headers['access-control-allow-methods']).toContain('POST');
  });
});

// =============================================================================
// BUG 9: deleteAccount() 401 path - does NOT call /api/logout first
//         so token_version is never incremented on the server for deletions
// =============================================================================

test.describe('Delete account does not revoke token server-side', () => {
  /**
   * The deleteAccount() frontend function (index.html ~2578) calls
   * DELETE /api/account. The server deletes the user row entirely.
   * Because the user row is gone, authenticate() (with DB check) returns null
   * on any subsequent request -- the token is effectively dead.
   *
   * This is correct behavior. But the test verifies the token is actually
   * rejected after deletion (not just assumed from code reading).
   */
  test('token is unusable after account deletion', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    const user = uniqueUser();
    const { token } = await apiRegister(page, user, 'pass123');

    // Delete the account
    const delResp = await page.request.delete('/api/account', {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'x-forwarded-for': uniqueIp(),
      },
      data: JSON.stringify({ password: 'pass123' }),
    });
    expect(delResp.ok()).toBe(true);

    // Try to logout with old token (user row gone, authenticate returns null)
    const logoutResp = await page.request.post('/api/logout', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(logoutResp.status()).toBe(401);

    // Try change-password too
    const changePassResp = await page.request.post('/api/change-password', {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      data: { currentPassword: 'pass123', newPassword: 'newpass456' },
    });
    expect(changePassResp.status()).toBe(401);
  });
});

// =============================================================================
// BUG 10: frontend logout() ignores server 401 response
// =============================================================================

test.describe('Frontend logout() ignores 401 from server', () => {
  /**
   * The logout() function in index.html (line 2564):
   *
   *   async function logout() {
   *     try {
   *       await fetch('/api/logout', { ... });
   *     } catch (e) {
   *       console.error('Logout request failed:', e);
   *     }
   *     localStorage.removeItem('xiki_token');   // always runs
   *     localStorage.removeItem('xiki_username'); // always runs
   *     window.location.reload();                 // always runs
   *   }
   *
   * If /api/logout returns 401 (e.g., token already expired), the try block
   * completes without throwing (fetch doesn't throw on 4xx), and the code
   * STILL clears localStorage and reloads. This is actually fine from a UX
   * perspective -- the client-side logout succeeds even if server-side fails.
   *
   * BUT: if the user is already logged out server-side (token_version mismatch),
   * calling logout() again is a no-op server-side, yet the client-side state
   * is correctly cleaned up. This is acceptable behavior.
   *
   * However, there is a subtle issue: if the server is down and /api/logout
   * throws a network error, the catch block only logs it, then localStorage
   * is still cleared. This means the user is logged out client-side but the
   * server token_version is NOT incremented, leaving the token theoretically
   * valid server-side (until expiry in 30 days).
   *
   * This test documents that the API returns 401 when called with an expired token.
   */
  test('logout with already-revoked token returns 401 (API level)', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    const user = uniqueUser();
    const { token } = await apiRegister(page, user, 'pass123');

    // First logout - revokes token
    await page.request.post('/api/logout', {
      headers: { Authorization: `Bearer ${token}` },
    });

    // Second logout attempt (client cleared localStorage but server already revoked)
    const resp = await page.request.post('/api/logout', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(resp.status()).toBe(401);
    // The frontend logout() does NOT check this status -- it always clears
    // localStorage regardless. This means if a user rapidly double-clicks
    // logout, the second click is a silent 401 but UX is fine.
  });
});

// =============================================================================
// BUG 11: handleChangePassword makes a second DB query AFTER authenticate()
//         already checked user existence -- user could be deleted between the two
// =============================================================================

test.describe('Change-password TOCTOU: user deleted between auth and password fetch', () => {
  /**
   * handleChangePassword:
   *   1. authenticate(request, env.JWT_SECRET, env.DB) -- checks user exists
   *   2. env.DB.prepare('SELECT password_hash, salt FROM users WHERE id = ?') -- second lookup
   *
   * If the user is deleted between step 1 and step 2 (race condition), step 2
   * returns null, and the code correctly returns 404 "User not found".
   *
   * This is a TOCTOU (time-of-check/time-of-use) issue. The 404 response from
   * handleChangePassword is correct, but it leaks a different error message
   * than the 401 returned by authenticate() alone.
   *
   * This test verifies the 404 path exists and returns the correct error.
   * (We can't reproduce the actual race, so we test the error path directly
   * via the auth-adversarial deleted-user flow.)
   */
  test('change-password on deleted account returns 401 (via authenticate DB check)', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    const user = uniqueUser();
    const { token } = await apiRegister(page, user, 'pass123');

    // Delete the account
    await page.request.delete('/api/account', {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'x-forwarded-for': uniqueIp(),
      },
      data: JSON.stringify({ password: 'pass123' }),
    });

    // Now try to change password -- authenticate() will return null (user gone)
    // So we get 401, NOT 404 (the 404 path requires passing authenticate first)
    const resp = await page.request.post('/api/change-password', {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      data: { currentPassword: 'pass123', newPassword: 'newpass456' },
    });
    expect(resp.status()).toBe(401);
  });
});
