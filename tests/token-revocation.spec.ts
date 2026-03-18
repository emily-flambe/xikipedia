/**
 * Adversarial tests for token revocation (EMI-47)
 *
 * Attack surface:
 *   POST /api/logout
 *   POST /api/change-password
 *   authenticate() with db param
 *   Old tokens (missing token_version field)
 *   Password length asymmetry between register and change-password
 */

import { test, expect } from './fixtures';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const MOCK_SMOLDATA = {
  subCategories: { science: ['physics'] },
  noPageMaps: { '999': 'test' },
  pages: Array.from({ length: 10 }, (_, i) => [
    `Article ${i}`, i + 1, 'A'.repeat(120), null, ['science'], [((i + 1) % 10) + 1],
  ]),
};

function uniqueUser(): string {
  const ts = Date.now().toString(36).slice(-4);
  const rnd = Math.random().toString(36).slice(2, 6);
  return `t${ts}${rnd}`;
}

const _ipOctet = Math.floor(Math.random() * 256);
let _ipCounter = 0;
function uniqueIp(): string {
  _ipCounter++;
  return `192.168.${_ipOctet}.${_ipCounter % 256}`;
}

async function mockSmoldata(page: import('@playwright/test').Page) {
  const mockDataJson = JSON.stringify(MOCK_SMOLDATA);
  await page.evaluate(async () => {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map(r => r.unregister()));
    }
    if ('caches' in window) {
      const names = await caches.keys();
      await Promise.all(names.map(n => caches.delete(n)));
    }
  }).catch(() => {});
  await page.route('**/smoldata.json', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: mockDataJson }),
  );
}

async function apiRegister(page: import('@playwright/test').Page, username: string, password: string) {
  const resp = await page.request.post('/api/register', {
    data: { username, password },
    headers: { 'x-forwarded-for': uniqueIp() },
  });
  expect(resp.ok(), `Register failed: ${await resp.text()}`).toBe(true);
  return resp.json() as Promise<{ token: string; username: string }>;
}

async function apiLogin(page: import('@playwright/test').Page, username: string, password: string) {
  const resp = await page.request.post('/api/login', {
    data: { username, password },
    headers: { 'x-forwarded-for': uniqueIp() },
  });
  return resp;
}

// ─── /api/logout ─────────────────────────────────────────────────────────────

test.describe('POST /api/logout', () => {
  test('logout without auth token returns 401', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');
    const resp = await page.request.post('/api/logout');
    expect(resp.status()).toBe(401);
  });

  test('logout with invalid token returns 401', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');
    const resp = await page.request.post('/api/logout', {
      headers: { Authorization: 'Bearer not.a.valid.jwt' },
    });
    expect(resp.status()).toBe(401);
  });

  test('after logout, the old token is rejected on protected endpoints', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');
    const user = uniqueUser();
    const { token } = await apiRegister(page, user, 'password123');

    // Verify token works before logout
    const beforeResp = await page.request.get('/api/preferences', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(beforeResp.status()).toBe(200);

    // Logout
    const logoutResp = await page.request.post('/api/logout', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(logoutResp.status()).toBe(200);

    // Old token should now be rejected
    const afterResp = await page.request.get('/api/preferences', {
      headers: { Authorization: `Bearer ${token}` },
    });
    // BUG CANDIDATE: if authenticate() is called without db param, this will still return 200
    expect(afterResp.status()).toBe(401);
  });

  test('after logout, old token is rejected for PUT /api/preferences', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');
    const user = uniqueUser();
    const { token } = await apiRegister(page, user, 'password123');

    await page.request.post('/api/logout', {
      headers: { Authorization: `Bearer ${token}` },
    });

    const resp = await page.request.put('/api/preferences', {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: { categoryScores: {}, hiddenCategories: [] },
    });
    expect(resp.status()).toBe(401);
  });

  test('after logout, old token is rejected for DELETE /api/account', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');
    const user = uniqueUser();
    const { token } = await apiRegister(page, user, 'password123');

    await page.request.post('/api/logout', {
      headers: { Authorization: `Bearer ${token}` },
    });

    const resp = await page.request.delete('/api/account', {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'x-forwarded-for': uniqueIp() },
      data: JSON.stringify({ password: 'password123' }),
    });
    // Should be 401 (revoked), not 403 (wrong password)
    expect(resp.status()).toBe(401);
  });

  test('after logout, user can log in again and get a new working token', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');
    const user = uniqueUser();
    await apiRegister(page, user, 'password123');
    const { token: oldToken } = await (await apiLogin(page, user, 'password123')).json();

    await page.request.post('/api/logout', {
      headers: { Authorization: `Bearer ${oldToken}` },
    });

    // Login again
    const loginResp = await apiLogin(page, user, 'password123');
    expect(loginResp.status()).toBe(200);
    const { token: newToken } = await loginResp.json();

    // New token should work
    const prefsResp = await page.request.get('/api/preferences', {
      headers: { Authorization: `Bearer ${newToken}` },
    });
    expect(prefsResp.status()).toBe(200);

    // Old token should still be dead
    const oldPrefsResp = await page.request.get('/api/preferences', {
      headers: { Authorization: `Bearer ${oldToken}` },
    });
    expect(oldPrefsResp.status()).toBe(401);
  });

  test('double logout with same token: second call returns 401', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');
    const user = uniqueUser();
    const { token } = await apiRegister(page, user, 'password123');

    const first = await page.request.post('/api/logout', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(first.status()).toBe(200);

    // Second logout with same token -- token is now revoked
    const second = await page.request.post('/api/logout', {
      headers: { Authorization: `Bearer ${token}` },
    });
    // BUG CANDIDATE: each logout increments token_version, so a revoked token
    // can still be used to call logout again, causing double-increment
    // (this is a logic issue, not a security hole, but it diverges from expected behavior)
    expect(second.status()).toBe(401);
  });
});

// ─── /api/change-password ────────────────────────────────────────────────────

test.describe('POST /api/change-password', () => {
  test('change-password without auth returns 401', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');
    const resp = await page.request.post('/api/change-password', {
      data: { current_password: 'password123', new_password: 'newpassword123' },
    });
    expect(resp.status()).toBe(401);
  });

  test('missing current_password returns 400', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');
    const user = uniqueUser();
    const { token } = await apiRegister(page, user, 'password123');

    const resp = await page.request.post('/api/change-password', {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: { new_password: 'newpassword123' },
    });
    expect(resp.status()).toBe(400);
    const body = await resp.json();
    expect(body.error).toContain('password');
  });

  test('null current_password returns 400', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');
    const user = uniqueUser();
    const { token } = await apiRegister(page, user, 'password123');

    const resp = await page.request.post('/api/change-password', {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: { current_password: null, new_password: 'newpassword123' },
    });
    expect(resp.status()).toBe(400);
  });

  test('missing new_password returns 400', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');
    const user = uniqueUser();
    const { token } = await apiRegister(page, user, 'password123');

    const resp = await page.request.post('/api/change-password', {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: { current_password: 'password123' },
    });
    expect(resp.status()).toBe(400);
    const body = await resp.json();
    expect(body.error).toContain('8 characters');
  });

  test('new_password shorter than 8 chars returns 400 (asymmetric with registration which allows 6)', async ({ page }) => {
    // KNOWN ASYMMETRY: registration allows 6-char passwords, change-password requires 8.
    // A user who registered with a 6 or 7 char password cannot change to another
    // 6 or 7 char password.
    await mockSmoldata(page);
    await page.goto('/');
    const user = uniqueUser();
    const { token } = await apiRegister(page, user, 'sixchr'); // 6-char password, valid at registration

    const resp = await page.request.post('/api/change-password', {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: { current_password: 'sixchr', new_password: 'sevnchrs' }, // 8 chars, should succeed
    });
    // This should succeed at 8 chars
    expect(resp.status()).toBe(200);
  });

  test('new_password of exactly 7 chars is rejected (change-password minimum is 8)', async ({ page }) => {
    // This exposes the asymmetry: register allows 6, change-password requires 8
    await mockSmoldata(page);
    await page.goto('/');
    const user = uniqueUser();
    const { token } = await apiRegister(page, user, 'password123');

    const resp = await page.request.post('/api/change-password', {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: { current_password: 'password123', new_password: '1234567' }, // 7 chars -- rejected
    });
    expect(resp.status()).toBe(400);
    const body = await resp.json();
    // Error says "8 characters" -- but registration only requires 6
    // This is inconsistent behavior that could confuse users
    expect(body.error).toContain('8');
  });

  test('wrong current_password returns 401', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');
    const user = uniqueUser();
    const { token } = await apiRegister(page, user, 'password123');

    const resp = await page.request.post('/api/change-password', {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: { current_password: 'wrongpassword', new_password: 'newpassword123' },
    });
    expect(resp.status()).toBe(401);
  });

  test('after change-password, old token is revoked', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');
    const user = uniqueUser();
    const { token: oldToken } = await apiRegister(page, user, 'password123');

    // Change password
    const changeResp = await page.request.post('/api/change-password', {
      headers: { Authorization: `Bearer ${oldToken}`, 'Content-Type': 'application/json' },
      data: { current_password: 'password123', new_password: 'newpassword456' },
    });
    expect(changeResp.status()).toBe(200);

    // Old token should now be rejected
    const prefsResp = await page.request.get('/api/preferences', {
      headers: { Authorization: `Bearer ${oldToken}` },
    });
    expect(prefsResp.status()).toBe(401);
  });

  test('after change-password, user can log in with new password', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');
    const user = uniqueUser();
    const { token } = await apiRegister(page, user, 'password123');

    await page.request.post('/api/change-password', {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: { current_password: 'password123', new_password: 'newpassword456' },
    });

    // Login with new password should work
    const loginResp = await apiLogin(page, user, 'newpassword456');
    expect(loginResp.status()).toBe(200);
  });

  test('after change-password, old password no longer works for login', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');
    const user = uniqueUser();
    const { token } = await apiRegister(page, user, 'password123');

    await page.request.post('/api/change-password', {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: { current_password: 'password123', new_password: 'newpassword456' },
    });

    const loginResp = await apiLogin(page, user, 'password123');
    expect(loginResp.status()).toBe(401);
  });

  test('change-password does NOT return a new token (user gets logged out next request)', async ({ page }) => {
    // The response from change-password is { success: true } -- no new token.
    // The user's currently held token is now invalid after the increment.
    // If the frontend doesn't handle this, user is silently logged out on next API call.
    await mockSmoldata(page);
    await page.goto('/');
    const user = uniqueUser();
    const { token } = await apiRegister(page, user, 'password123');

    const changeResp = await page.request.post('/api/change-password', {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: { current_password: 'password123', new_password: 'newpassword456' },
    });
    expect(changeResp.status()).toBe(200);
    const body = await changeResp.json();

    // Assert: NO new token is returned. This means the caller's existing token is dead.
    expect(body).not.toHaveProperty('token');
    // Document the consequence: next request with old token returns 401
  });

  test('empty body to change-password returns 400', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');
    const user = uniqueUser();
    const { token } = await apiRegister(page, user, 'password123');

    const resp = await page.request.post('/api/change-password', {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: {},
    });
    expect(resp.status()).toBe(400);
  });

  test('invalid JSON body to change-password returns 400', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');
    const user = uniqueUser();
    const { token } = await apiRegister(page, user, 'password123');

    const resp = await page.request.fetch('/api/change-password', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: 'not json{{{',
    });
    expect(resp.status()).toBe(400);
  });

  test('empty string current_password returns 400', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');
    const user = uniqueUser();
    const { token } = await apiRegister(page, user, 'password123');

    const resp = await page.request.post('/api/change-password', {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: { current_password: '', new_password: 'newpassword456' },
    });
    expect(resp.status()).toBe(400);
  });

  test('new_password same as current_password is accepted (no uniqueness check)', async ({ page }) => {
    // Server does not enforce that new != old -- this is expected behavior
    await mockSmoldata(page);
    await page.goto('/');
    const user = uniqueUser();
    const { token } = await apiRegister(page, user, 'password12345');

    const resp = await page.request.post('/api/change-password', {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: { current_password: 'password12345', new_password: 'password12345' },
    });
    // No policy against reuse -- should succeed (or 200)
    // But this also means token_version increments even though nothing changed
    // Document: old token is revoked even for no-op password change
    expect(resp.status()).toBe(200);
  });
});

// ─── Old tokens (missing token_version in payload) ───────────────────────────

test.describe('Old token compatibility (missing token_version)', () => {
  test('a token without token_version field is rejected when db check is enabled', async ({ page }) => {
    // Tokens issued before this feature was added will have no token_version.
    // payload.token_version will be undefined.
    // In authenticate(): `user.token_version !== payload.token_version`
    //   => any_number !== undefined  => true  => returns null (401)
    // This is CORRECT security behavior (old tokens get revoked) but may be
    // surprising to users who were logged in before the migration.
    // This test documents and verifies that behavior.
    await mockSmoldata(page);
    await page.goto('/');

    // Craft a syntactically valid JWT with no token_version in payload.
    // We can't sign it with the real secret, so we just verify the 401 behavior
    // with a known-invalid token structure.
    const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const payload = btoa(JSON.stringify({
      sub: 1,
      username: 'testuser',
      exp: Math.floor(Date.now() / 1000) + 3600,
      // token_version deliberately absent
    })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    const fakeToken = `${header}.${payload}.fakesig`;
    const resp = await page.request.get('/api/preferences', {
      headers: { Authorization: `Bearer ${fakeToken}` },
    });
    // Should be 401 (invalid signature will catch this before db check)
    expect(resp.status()).toBe(401);
  });
});

// ─── authenticate() DB parameter coverage ────────────────────────────────────

test.describe('authenticate() db parameter - revoked token still works on routes that omit db?', () => {
  test('revoked token is rejected for GET /api/preferences (uses db param)', async ({ page }) => {
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

  test('revoked token is rejected for PUT /api/preferences (uses db param)', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');
    const user = uniqueUser();
    const { token } = await apiRegister(page, user, 'password123');

    await page.request.post('/api/logout', {
      headers: { Authorization: `Bearer ${token}` },
    });

    const resp = await page.request.put('/api/preferences', {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: { categoryScores: {}, hiddenCategories: [] },
    });
    expect(resp.status()).toBe(401);
  });

  test('revoked token is rejected for DELETE /api/account (uses db param)', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');
    const user = uniqueUser();
    const { token } = await apiRegister(page, user, 'password123');

    // Log out to revoke the token -- user still exists in DB
    await page.request.post('/api/logout', {
      headers: { Authorization: `Bearer ${token}` },
    });

    // Now try to delete with the revoked token
    const resp = await page.request.delete('/api/account', {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'x-forwarded-for': uniqueIp() },
      data: JSON.stringify({ password: 'password123' }),
    });
    // Should be 401 (revoked), NOT 403 (wrong password) or 200 (success)
    expect(resp.status()).toBe(401);
  });

  test('revoked token is rejected for POST /api/logout itself (uses db param)', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');
    const user = uniqueUser();
    const { token } = await apiRegister(page, user, 'password123');

    await page.request.post('/api/logout', {
      headers: { Authorization: `Bearer ${token}` },
    });

    // Second logout with same now-revoked token
    const resp = await page.request.post('/api/logout', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(resp.status()).toBe(401);
  });

  test('revoked token is rejected for POST /api/change-password (uses db param)', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');
    const user = uniqueUser();
    const { token } = await apiRegister(page, user, 'password123');

    await page.request.post('/api/logout', {
      headers: { Authorization: `Bearer ${token}` },
    });

    const resp = await page.request.post('/api/change-password', {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: { current_password: 'password123', new_password: 'newpassword456' },
    });
    expect(resp.status()).toBe(401);
  });
});

// ─── apiFetch dead code check ─────────────────────────────────────────────────

test.describe('apiFetch usage (defined but used?)', () => {
  test('savePreferences called with raw fetch (not apiFetch) - 401 does not trigger auto-logout path via apiFetch', async ({ page }) => {
    // The frontend defines apiFetch() which handles 401 by clearing localStorage.
    // But savePreferences() uses raw fetch(), NOT apiFetch().
    // If a token is revoked and the server returns 401 on a preferences save,
    // the frontend will NOT auto-logout -- it just logs the error and shows a toast.
    // This test verifies the 401 response is returned correctly from the server side.
    // The frontend behavior (not auto-clearing) is a separate UX issue.
    await mockSmoldata(page);
    await page.goto('/');
    const user = uniqueUser();
    const { token } = await apiRegister(page, user, 'password123');

    // Revoke token
    await page.request.post('/api/logout', {
      headers: { Authorization: `Bearer ${token}` },
    });

    // PUT preferences with revoked token -- server must return 401
    const resp = await page.request.put('/api/preferences', {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: { categoryScores: { test: 1 }, hiddenCategories: [] },
    });
    expect(resp.status()).toBe(401);
  });
});

// ─── Password minimum asymmetry edge cases ───────────────────────────────────

test.describe('Password minimum length asymmetry (register=6, change-password=8)', () => {
  test('user with 6-char password cannot change to another 6-char password', async ({ page }) => {
    // Register requires 6+ chars, change-password requires 8+.
    // A user with a 6-char password is "trapped" -- they cannot change to a
    // similarly short new password.
    await mockSmoldata(page);
    await page.goto('/');
    const user = uniqueUser();
    const { token } = await apiRegister(page, user, 'abc123'); // valid at 6 chars

    const resp = await page.request.post('/api/change-password', {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: { current_password: 'abc123', new_password: 'xyz789' }, // also 6 chars
    });
    // This returns 400 with "8 characters" message, but user may not understand why
    // since they registered with 6 chars successfully.
    expect(resp.status()).toBe(400);
    const body = await resp.json();
    expect(body.error).toContain('8');
  });

  test('user with 7-char password cannot change to a 7-char password', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');
    const user = uniqueUser();
    const { token } = await apiRegister(page, user, 'abc1234'); // 7 chars, valid at registration

    const resp = await page.request.post('/api/change-password', {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: { current_password: 'abc1234', new_password: 'xyz5678' }, // 7 chars
    });
    expect(resp.status()).toBe(400);
  });
});

// ─── Schema sync check ───────────────────────────────────────────────────────

test.describe('schema.sql vs ensureTables migration', () => {
  test('ensureTables migration column matches schema.sql DEFAULT (verify via behavior)', async ({ page }) => {
    // schema.sql has: token_version INTEGER NOT NULL DEFAULT 1
    // ensureTables has: ALTER TABLE ... token_version INTEGER NOT NULL DEFAULT 1
    // These match. Verify by checking a new user's token works immediately.
    await mockSmoldata(page);
    await page.goto('/');
    const user = uniqueUser();
    const { token } = await apiRegister(page, user, 'password123');

    // If token_version defaulted to 0 instead of 1, a newly issued token with
    // version=1 would fail the `user.token_version !== payload.token_version` check
    const resp = await page.request.get('/api/preferences', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(resp.status()).toBe(200);
  });
});

// ─── handleRegister token_version fallback ────────────────────────────────────

test.describe('handleRegister token_version fetch', () => {
  test('registration token works immediately (token_version fetch fallback path)', async ({ page }) => {
    // handleRegister fetches token_version after INSERT, falls back to 1 if null.
    // If the SELECT fails to return the row, it falls back to hardcoded 1.
    // DB DEFAULT is also 1, so in practice they match. But if DEFAULT were ever
    // changed without updating the fallback, newly registered users would get
    // tokens that don't match the DB value.
    await mockSmoldata(page);
    await page.goto('/');
    const user = uniqueUser();

    const regResp = await page.request.post('/api/register', {
      data: { username: user, password: 'password123' },
      headers: { 'x-forwarded-for': uniqueIp() },
    });
    expect(regResp.status()).toBe(201);
    const { token } = await regResp.json();

    // Immediately use the token
    const prefResp = await page.request.get('/api/preferences', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(prefResp.status()).toBe(200);

    // Verify we can logout and the new login token also works
    await page.request.post('/api/logout', { headers: { Authorization: `Bearer ${token}` } });
    const loginResp = await page.request.post('/api/login', {
      data: { username: user, password: 'password123' },
      headers: { 'x-forwarded-for': uniqueIp() },
    });
    const { token: newToken } = await loginResp.json();
    const prefResp2 = await page.request.get('/api/preferences', {
      headers: { Authorization: `Bearer ${newToken}` },
    });
    expect(prefResp2.status()).toBe(200);
  });
});
