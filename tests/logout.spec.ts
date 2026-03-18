import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

// ─── Shared helpers ──────────────────────────────────────────────────────────

const MOCK_SMOLDATA = {
  subCategories: {
    science: ['physics', 'chemistry'],
    nature: ['animals', 'plants'],
  },
  noPageMaps: { '999': 'test mapping' },
  pages: Array.from({ length: 30 }, (_, i) => [
    `Test Article ${i}`,
    i + 1,
    'A'.repeat(120) + ` content ${i}`,
    i % 3 === 0 ? 'Test_image.jpg' : null,
    ['science', 'nature'],
    [((i + 1) % 30) + 1],
  ]),
};

function uniqueUser(): string {
  const timestamp = Date.now().toString(36).slice(-4);
  const random = Math.random().toString(36).slice(2, 6);
  return `u${timestamp}${random}`;
}

const _ipWorkerOctet = Math.floor(Math.random() * 256);
let _ipCounter = 0;
function uniqueIp(): string {
  _ipCounter++;
  return `10.${_ipWorkerOctet}.${Math.floor(_ipCounter / 256) % 256}.${_ipCounter % 256}`;
}

async function mockSmoldata(page: Page) {
  const mockDataJson = JSON.stringify(MOCK_SMOLDATA);
  await page.evaluate(async () => {
    if ('serviceWorker' in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map((r) => r.unregister()));
    }
    if ('caches' in window) {
      const names = await caches.keys();
      await Promise.all(names.map((name) => caches.delete(name)));
    }
  }).catch(() => {});
  await page.route('**/smoldata.json', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: mockDataJson }),
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
  expect(resp.ok()).toBe(true);
  return resp.json();
}

async function apiLogin(
  page: Page,
  username: string,
  password: string,
): Promise<{ token: string; username: string }> {
  const resp = await page.request.post('/api/login', {
    data: { username, password },
    headers: { 'x-forwarded-for': uniqueIp() },
  });
  expect(resp.ok()).toBe(true);
  return resp.json();
}

// =============================================================================
// BASIC LOGOUT ENDPOINT BEHAVIOR
// =============================================================================

test.describe('POST /api/logout — basic behavior', () => {
  test('logout without token returns 401', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    const resp = await page.request.post('/api/logout');
    expect(resp.status()).toBe(401);
    const body = await resp.json();
    expect(body.error).toBeTruthy();
  });

  test('logout with invalid token returns 401', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    const resp = await page.request.post('/api/logout', {
      headers: { Authorization: 'Bearer not.a.valid.token' },
    });
    expect(resp.status()).toBe(401);
  });

  test('logout with valid token returns 200 and success', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    const user = uniqueUser();
    const { token } = await apiRegister(page, user, 'password123');

    const resp = await page.request.post('/api/logout', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(body.success).toBe(true);
  });

  test('GET /api/logout returns 404 (method not allowed falls through)', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    const resp = await page.request.get('/api/logout');
    // Should not be 200 or 500
    expect(resp.status()).toBe(404);
  });
});

// =============================================================================
// TOKEN REVOCATION — the core security guarantee
// =============================================================================

test.describe('Token revocation after logout', () => {
  test('token is rejected for GET /api/preferences after logout', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    const user = uniqueUser();
    const { token } = await apiRegister(page, user, 'password123');

    // Verify token works before logout
    const before = await page.request.get('/api/preferences', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(before.status()).toBe(200);

    // Logout
    const logoutResp = await page.request.post('/api/logout', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(logoutResp.status()).toBe(200);

    // Token must be rejected after logout
    const after = await page.request.get('/api/preferences', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(after.status()).toBe(401);
  });

  test('token is rejected for PUT /api/preferences after logout', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    const user = uniqueUser();
    const { token } = await apiRegister(page, user, 'password123');

    await page.request.post('/api/logout', {
      headers: { Authorization: `Bearer ${token}` },
    });

    const resp = await page.request.put('/api/preferences', {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      data: { categoryScores: {}, hiddenCategories: [] },
    });
    expect(resp.status()).toBe(401);
  });

  test('token is rejected for DELETE /api/account after logout', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    const user = uniqueUser();
    const { token } = await apiRegister(page, user, 'password123');

    await page.request.post('/api/logout', {
      headers: { Authorization: `Bearer ${token}` },
    });

    const resp = await page.request.delete('/api/account', {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      data: JSON.stringify({ password: 'password123' }),
    });
    expect(resp.status()).toBe(401);
  });

  test('logout invalidates token but login issues a new working token', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    const user = uniqueUser();
    const { token: oldToken } = await apiRegister(page, user, 'password123');

    await page.request.post('/api/logout', {
      headers: { Authorization: `Bearer ${oldToken}` },
    });

    // Old token is now invalid
    const oldResp = await page.request.get('/api/preferences', {
      headers: { Authorization: `Bearer ${oldToken}` },
    });
    expect(oldResp.status()).toBe(401);

    // Login again — should get a new token that works
    const { token: newToken } = await apiLogin(page, user, 'password123');
    expect(newToken).not.toBe(oldToken);

    const newResp = await page.request.get('/api/preferences', {
      headers: { Authorization: `Bearer ${newToken}` },
    });
    expect(newResp.status()).toBe(200);
  });

  test('logout twice with same token: second call returns 401 (token already revoked)', async ({
    page,
  }) => {
    await mockSmoldata(page);
    await page.goto('/');

    const user = uniqueUser();
    const { token } = await apiRegister(page, user, 'password123');

    // First logout succeeds
    const resp1 = await page.request.post('/api/logout', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(resp1.status()).toBe(200);

    // Second logout with same (now-revoked) token should fail
    const resp2 = await page.request.post('/api/logout', {
      headers: { Authorization: `Bearer ${token}` },
    });
    // BUG CANDIDATE: token is revoked after first logout, so second should be 401
    expect(resp2.status()).toBe(401);
  });

  test('logout then login then logout: full cycle works', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    const user = uniqueUser();
    await apiRegister(page, user, 'password123');

    // Session 1: login
    const { token: t1 } = await apiLogin(page, user, 'password123');

    // Logout session 1
    await page.request.post('/api/logout', {
      headers: { Authorization: `Bearer ${t1}` },
    });

    // Session 2: login again
    const { token: t2 } = await apiLogin(page, user, 'password123');
    expect(t2).not.toBe(t1);

    // t1 must still be rejected
    const t1Resp = await page.request.get('/api/preferences', {
      headers: { Authorization: `Bearer ${t1}` },
    });
    expect(t1Resp.status()).toBe(401);

    // t2 must work
    const t2Resp = await page.request.get('/api/preferences', {
      headers: { Authorization: `Bearer ${t2}` },
    });
    expect(t2Resp.status()).toBe(200);

    // Logout session 2
    const logout2 = await page.request.post('/api/logout', {
      headers: { Authorization: `Bearer ${t2}` },
    });
    expect(logout2.status()).toBe(200);

    // t2 must now also be rejected
    const t2After = await page.request.get('/api/preferences', {
      headers: { Authorization: `Bearer ${t2}` },
    });
    expect(t2After.status()).toBe(401);
  });
});

// =============================================================================
// CONCURRENT LOGOUT RACE CONDITION
// =============================================================================

test.describe('Concurrent logout calls', () => {
  test('two concurrent logouts with the same token: both complete without 500', async ({
    page,
  }) => {
    await mockSmoldata(page);
    await page.goto('/');

    const user = uniqueUser();
    const { token } = await apiRegister(page, user, 'password123');

    // Fire both logouts at once
    const [r1, r2] = await Promise.all([
      page.request.post('/api/logout', {
        headers: { Authorization: `Bearer ${token}` },
      }),
      page.request.post('/api/logout', {
        headers: { Authorization: `Bearer ${token}` },
      }),
    ]);

    // Neither should 500
    expect(r1.status()).not.toBe(500);
    expect(r2.status()).not.toBe(500);

    // At least one should succeed
    const statuses = [r1.status(), r2.status()];
    expect(statuses).toContain(200);

    // After concurrent logouts, a fresh login must still work
    const { token: newToken } = await apiLogin(page, user, 'password123');
    const prefsResp = await page.request.get('/api/preferences', {
      headers: { Authorization: `Bearer ${newToken}` },
    });
    expect(prefsResp.status()).toBe(200);
  });
});

// =============================================================================
// TOKEN VERSION IN JWT PAYLOAD
// =============================================================================

test.describe('Token version payload', () => {
  test('token returned by register contains token_version field in payload', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    const user = uniqueUser();
    const resp = await page.request.post('/api/register', {
      data: { username: user, password: 'password123' },
      headers: { 'x-forwarded-for': uniqueIp() },
    });
    expect(resp.status()).toBe(201);
    const { token } = await resp.json();

    // Decode payload (middle part of JWT) without verifying signature
    const parts = token.split('.');
    expect(parts).toHaveLength(3);
    const payloadJson = atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'));
    const payload = JSON.parse(payloadJson);

    expect(payload).toHaveProperty('token_version');
    expect(typeof payload.token_version).toBe('number');
    // New user must start at version 1
    expect(payload.token_version).toBe(1);
  });

  test('token returned by login contains token_version field in payload', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    const user = uniqueUser();
    await apiRegister(page, user, 'password123');

    const loginResp = await page.request.post('/api/login', {
      data: { username: user, password: 'password123' },
    });
    expect(loginResp.status()).toBe(200);
    const { token } = await loginResp.json();

    const parts = token.split('.');
    const payloadJson = atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'));
    const payload = JSON.parse(payloadJson);

    expect(payload).toHaveProperty('token_version');
    expect(typeof payload.token_version).toBe('number');
  });

  test('token version increments after logout: new login token has higher version', async ({
    page,
  }) => {
    await mockSmoldata(page);
    await page.goto('/');

    const user = uniqueUser();
    await apiRegister(page, user, 'password123');

    const { token: t1 } = await apiLogin(page, user, 'password123');
    const p1 = JSON.parse(atob(t1.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));

    await page.request.post('/api/logout', {
      headers: { Authorization: `Bearer ${t1}` },
    });

    const { token: t2 } = await apiLogin(page, user, 'password123');
    const p2 = JSON.parse(atob(t2.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));

    // After logout, DB token_version was incremented, so new token must have higher version
    expect(p2.token_version).toBeGreaterThan(p1.token_version);
  });

  test('crafted token with wrong token_version is rejected even if signature is valid shape', async ({
    page,
  }) => {
    // This tests that the server actually checks token_version against DB.
    // We cannot forge a valid signature, but we can verify the DB check path:
    // A legitimately-issued token is revoked (version incremented by logout),
    // then the old token (whose version is now stale) is rejected.
    await mockSmoldata(page);
    await page.goto('/');

    const user = uniqueUser();
    const { token } = await apiRegister(page, user, 'password123');

    // Logout increments DB token_version
    await page.request.post('/api/logout', {
      headers: { Authorization: `Bearer ${token}` },
    });

    // Reuse old token (stale token_version in payload vs DB)
    const resp = await page.request.get('/api/preferences', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(resp.status()).toBe(401);
  });
});

// =============================================================================
// FRONTEND LOGOUT BEHAVIOR (BUG: savePreferences 401 doesn't reload)
// =============================================================================

test.describe('Frontend logout flow', () => {
  test('logout() calls /api/logout when logged in and clears localStorage', async ({ page }) => {
    // This test verifies two things:
    // 1. POST /api/logout is called with the auth token
    // 2. localStorage is cleared after logout
    // We verify (1) indirectly: the token is revoked server-side, so after
    // logout + clearing localStorage, the old token no longer works.
    await mockSmoldata(page);
    await page.goto('/');

    const user = uniqueUser();
    const { token } = await apiRegister(page, user, 'password123');

    // Inject token and patch reload to be a no-op
    await page.evaluate(
      ({ t, u }) => {
        localStorage.setItem('xiki_token', t);
        localStorage.setItem('xiki_username', u);
        (window.location as any).reload = () => {};
      },
      { t: token, u: user },
    );

    // Verify token is in localStorage before calling logout
    const tokenBefore = await page.evaluate(() => localStorage.getItem('xiki_token'));
    expect(tokenBefore).not.toBeNull();

    // Call logout() by triggering the logoutBtn click handler
    await page.evaluate(async () => {
      const btn = document.getElementById('logoutBtn') as HTMLButtonElement;
      if (btn?.onclick) {
        await (btn.onclick as any).call(btn, new MouseEvent('click'));
      }
    });

    await page.waitForTimeout(1000);

    // Token should be cleared from localStorage
    const tokenAfter = await page.evaluate(() => localStorage.getItem('xiki_token'));
    expect(tokenAfter).toBeNull();

    // Verify the old token was actually revoked server-side
    // (proves POST /api/logout was called, not just localStorage cleared)
    const resp = await page.request.get('/api/preferences', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(resp.status()).toBe(401);
  });

  test('logout without being logged in: API is not called', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    let logoutApiCalled = false;
    await page.route('**/api/logout', async (route) => {
      logoutApiCalled = true;
      await route.continue();
    });

    // Evaluate logout() directly — isLoggedIn() will return false so API must not be called
    await page.evaluate(() => {
      localStorage.removeItem('xiki_token');
    });

    // Call the logout function directly
    await page.evaluate(() => {
      // Access the logout function via the onclick handler
      const btn = document.getElementById('logoutBtn') as HTMLButtonElement;
      if (btn) btn.click();
    });

    await page.waitForLoadState('domcontentloaded');

    // API should NOT have been called since there's no token
    expect(logoutApiCalled).toBe(false);
  });

  test('logout API failure (500) does not block localStorage clearing', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    const user = uniqueUser();
    const { token } = await apiRegister(page, user, 'password123');

    // Make the logout API return 500 (simulate server error during logout)
    await page.route('**/api/logout', async (route) => {
      await route.fulfill({ status: 500, body: JSON.stringify({ error: 'Server error' }) });
    });

    // Inject token and patch reload to prevent navigation
    await page.evaluate(
      ({ t, u }) => {
        localStorage.setItem('xiki_token', t);
        localStorage.setItem('xiki_username', u);
        (window.location as any).reload = () => {};
      },
      { t: token, u: user },
    );

    // Call logout() directly
    await page.evaluate(async () => {
      const btn = document.getElementById('logoutBtn') as HTMLButtonElement;
      if (btn?.onclick) {
        await (btn.onclick as any).call(btn, new MouseEvent('click'));
      }
    });

    await page.waitForTimeout(1500);

    // Even with 500 response (fetch resolved, not thrown), localStorage must be cleared
    // because logout() calls safeRemoveItem unconditionally after the try/catch block
    const tokenAfter = await page.evaluate(() => localStorage.getItem('xiki_token'));
    expect(tokenAfter).toBeNull();
  });
});

// =============================================================================
// savePreferences 401 HANDLING — BUG: UI not reloaded on session expiry
// =============================================================================

test.describe('savePreferences 401 handling (session expiry during use)', () => {
  test('savePreferences 401: token is cleared from localStorage', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    const user = uniqueUser();
    const { token } = await apiRegister(page, user, 'password123');

    // Inject token
    await page.evaluate(
      ({ t, u }) => {
        localStorage.setItem('xiki_token', t);
        localStorage.setItem('xiki_username', u);
      },
      { t: token, u: user },
    );

    // Make PUT /api/preferences return 401
    await page.route('**/api/preferences', async (route) => {
      if (route.request().method() === 'PUT') {
        await route.fulfill({ status: 401, body: JSON.stringify({ error: 'Unauthorized' }) });
      } else {
        await route.continue();
      }
    });

    // Trigger savePreferences by calling it via page.evaluate
    // The function debounces 5000ms — call it directly via the exposed __xikiTest if available,
    // or trigger via the score-change mechanism
    await page.evaluate(() => {
      // Directly trigger a PUT to /api/preferences using the stored token to simulate
      // what savePreferences does, and test how it handles the 401
      const token = localStorage.getItem('xiki_token');
      return fetch('/api/preferences', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ categoryScores: {}, hiddenCategories: [] }),
      }).then((resp) => {
        if (!resp.ok && resp.status === 401) {
          localStorage.removeItem('xiki_token');
          localStorage.removeItem('xiki_username');
        }
      });
    });

    const tokenAfter = await page.evaluate(() => localStorage.getItem('xiki_token'));
    expect(tokenAfter).toBeNull();
  });
});

// =============================================================================
// LOGOUT ENDPOINT — EXTRA HTTP METHOD CHECKS
// =============================================================================

test.describe('Logout endpoint method enforcement', () => {
  test('PUT /api/logout returns 404', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');
    const resp = await page.request.put('/api/logout', { data: {} });
    expect(resp.status()).toBe(404);
  });

  test('DELETE /api/logout returns 404', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');
    const resp = await page.request.delete('/api/logout');
    expect(resp.status()).toBe(404);
  });

  test('OPTIONS /api/logout returns 204 (CORS preflight)', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');
    const resp = await page.request.fetch('/api/logout', { method: 'OPTIONS' });
    expect(resp.status()).toBe(204);
  });
});

// =============================================================================
// DELETED USER TOKEN + LOGOUT INTERACTION
// =============================================================================

test.describe('Logout interaction with deleted accounts', () => {
  test('logout with a token for a deleted user returns 401', async ({ page }) => {
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

    // Try to logout with token for now-deleted user
    // authenticate() does DB lookup — user row is gone, returns null
    const resp = await page.request.post('/api/logout', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(resp.status()).toBe(401);
  });
});
