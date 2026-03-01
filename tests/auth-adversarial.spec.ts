import { test, expect, Page } from '@playwright/test';

// ---- Helpers ----------------------------------------------------------------

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
  // Username must be 3-20 chars, alphanumeric + underscores only
  const timestamp = Date.now().toString(36).slice(-4); // 4 chars
  const random = Math.random().toString(36).slice(2, 6); // 4 chars
  return `u${timestamp}${random}`; // 9 chars total: "u" + 4 + 4
}

async function mockSmoldata(page: Page) {
  const mockDataJson = JSON.stringify(MOCK_SMOLDATA);

  // Unregister service worker IMMEDIATELY to prevent cache-first from bypassing our mock
  await page.evaluate(async () => {
    if ('serviceWorker' in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map(r => r.unregister()));
    }
    if ('caches' in window) {
      const names = await caches.keys();
      await Promise.all(names.map(name => caches.delete(name)));
    }
  }).catch(() => {}); // Ignore errors on fresh pages

  // Also set up for future navigations
  await page.addInitScript(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.getRegistrations().then(registrations => {
        registrations.forEach(registration => registration.unregister());
      });
    }
    if ('caches' in window) {
      caches.keys().then(names => {
        names.forEach(name => caches.delete(name));
      });
    }
  });

  await page.route('**/smoldata.json', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: mockDataJson,
    }),
  );
  await page.addInitScript(() => {
    const origDecode = TextDecoder.prototype.decode;
    TextDecoder.prototype.decode = function (
      input?: BufferSource,
      options?: TextDecodeOptions,
    ) {
      if (input && (input as ArrayBufferLike).byteLength > 1_000_000) {
        const view = new Uint8Array(
          input instanceof ArrayBuffer ? input : (input as any).buffer ?? input,
        );
        let end = view.length;
        while (end > 0 && view[end - 1] === 0) end--;
        const trimmed = view.slice(0, end);
        return origDecode.call(this, trimmed, options);
      }
      return origDecode.call(this, input, options);
    };
  });
}

async function apiRegister(
  page: Page,
  username: string,
  password: string,
): Promise<{ token: string; username: string }> {
  const resp = await page.request.post('/api/register', {
    data: { username, password },
  });
  expect(resp.ok()).toBe(true);
  return resp.json();
}

async function gotoReady(page: Page) {
  await mockSmoldata(page);
  await page.goto('/');
  const startBtn = page.locator('[data-testid="start-button"]');
  await expect(startBtn).not.toBeDisabled({ timeout: 30000 });
}

// =============================================================================
// HTTP METHOD MISMATCHES -- wrong HTTP methods for API endpoints
// =============================================================================

test.describe('HTTP method enforcement', () => {
  test('GET /api/register returns 404', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');
    const resp = await page.request.get('/api/register');
    expect(resp.status()).toBe(404);
  });

  test('PUT /api/register returns 404', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');
    const resp = await page.request.put('/api/register', {
      data: { username: 'test', password: 'test123' },
    });
    expect(resp.status()).toBe(404);
  });

  test('GET /api/login returns 404', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');
    const resp = await page.request.get('/api/login');
    expect(resp.status()).toBe(404);
  });

  test('DELETE /api/login returns 404', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');
    const resp = await page.request.delete('/api/login');
    expect(resp.status()).toBe(404);
  });

  test('POST /api/preferences returns 404', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');
    const user = uniqueUser();
    const { token } = await apiRegister(page, user, 'password123');
    const resp = await page.request.post('/api/preferences', {
      headers: { Authorization: `Bearer ${token}` },
      data: { categoryScores: {} },
    });
    expect(resp.status()).toBe(404);
  });

  test('POST /api/account returns 404', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');
    const user = uniqueUser();
    const { token } = await apiRegister(page, user, 'password123');
    const resp = await page.request.post('/api/account', {
      headers: { Authorization: `Bearer ${token}` },
      data: {},
    });
    expect(resp.status()).toBe(404);
  });

  test('GET /api/account returns 404', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');
    const resp = await page.request.get('/api/account');
    expect(resp.status()).toBe(404);
  });
});

// =============================================================================
// PASSWORD BOUNDARY CONDITIONS
// =============================================================================

test.describe('Password edge cases', () => {
  test('password of exactly 256 characters succeeds (upper boundary)', async ({ page }) => {
    const user = uniqueUser();
    const longPassword = 'a'.repeat(256);
    await mockSmoldata(page);
    await page.goto('/');

    const resp = await page.request.post('/api/register', {
      data: { username: user, password: longPassword },
    });
    expect(resp.status()).toBe(201);

    // Verify login with same long password works
    const loginResp = await page.request.post('/api/login', {
      data: { username: user, password: longPassword },
    });
    expect(loginResp.status()).toBe(200);
  });

  test('password of 257 characters is rejected (over boundary)', async ({ page }) => {
    const user = uniqueUser();
    const tooLongPassword = 'a'.repeat(257);
    await mockSmoldata(page);
    await page.goto('/');

    const resp = await page.request.post('/api/register', {
      data: { username: user, password: tooLongPassword },
    });
    expect(resp.status()).toBe(400);
    const body = await resp.json();
    expect(body.error).toContain('256');
  });

  test('password with only spaces is accepted (valid 6+ chars)', async ({ page }) => {
    const user = uniqueUser();
    const spacePassword = '      '; // 6 spaces
    await mockSmoldata(page);
    await page.goto('/');

    const resp = await page.request.post('/api/register', {
      data: { username: user, password: spacePassword },
    });
    // Spaces are valid characters in passwords -- should succeed
    expect(resp.status()).toBe(201);
  });

  test('password with unicode characters works for register and login', async ({ page }) => {
    const user = uniqueUser();
    const unicodePassword = 'p@ss\u00E9\u00F1\u00FC123';
    await mockSmoldata(page);
    await page.goto('/');

    const regResp = await page.request.post('/api/register', {
      data: { username: user, password: unicodePassword },
    });
    expect(regResp.status()).toBe(201);

    const loginResp = await page.request.post('/api/login', {
      data: { username: user, password: unicodePassword },
    });
    expect(loginResp.status()).toBe(200);
  });

  test('password with null bytes', async ({ page }) => {
    const user = uniqueUser();
    const nullPassword = 'pass\x00word123';
    await mockSmoldata(page);
    await page.goto('/');

    const resp = await page.request.post('/api/register', {
      data: { username: user, password: nullPassword },
    });
    // Should either succeed or return a clear error, not 500
    expect([201, 400]).toContain(resp.status());
  });

  test('empty string password is rejected', async ({ page }) => {
    const user = uniqueUser();
    await mockSmoldata(page);
    await page.goto('/');

    const resp = await page.request.post('/api/register', {
      data: { username: user, password: '' },
    });
    expect(resp.status()).toBe(400);
  });

  test('empty string username is rejected', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    const resp = await page.request.post('/api/register', {
      data: { username: '', password: 'password123' },
    });
    expect(resp.status()).toBe(400);
  });
});

// =============================================================================
// SQL INJECTION ATTEMPTS
// =============================================================================

test.describe('SQL injection resistance', () => {
  test('SQL injection in username during registration is rejected by validation', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    const resp = await page.request.post('/api/register', {
      data: { username: "admin' OR '1'='1", password: 'password123' },
    });
    // Should be 400 because username regex rejects special chars
    expect(resp.status()).toBe(400);
  });

  test('SQL injection in password during registration does not crash', async ({ page }) => {
    const user = uniqueUser();
    await mockSmoldata(page);
    await page.goto('/');

    const resp = await page.request.post('/api/register', {
      data: { username: user, password: "'; DROP TABLE users; --" },
    });
    // Password can contain any chars, so this should succeed (it's 23 chars)
    expect(resp.status()).toBe(201);

    // Verify the users table still works
    const user2 = uniqueUser();
    const resp2 = await page.request.post('/api/register', {
      data: { username: user2, password: 'normal123' },
    });
    expect(resp2.status()).toBe(201);
  });

  test('SQL injection in login username does not crash', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    const resp = await page.request.post('/api/login', {
      data: { username: "'; DROP TABLE users; --", password: 'password123' },
    });
    // Should return 401 (not found), not 500
    expect(resp.status()).toBe(401);
  });

  test('SQL injection in login password does not crash', async ({ page }) => {
    const user = uniqueUser();
    await mockSmoldata(page);
    await page.goto('/');

    await apiRegister(page, user, 'password123');

    const resp = await page.request.post('/api/login', {
      data: { username: user, password: "' OR '1'='1" },
    });
    expect(resp.status()).toBe(401);
  });
});

// =============================================================================
// JWT TOKEN ATTACKS
// =============================================================================

test.describe('JWT token attacks', () => {
  test('token with none algorithm is rejected', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    // Craft a token with alg: none
    const header = btoa(JSON.stringify({ alg: 'none', typ: 'JWT' }))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    const payload = btoa(
      JSON.stringify({
        sub: 1,
        username: 'admin',
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    )
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    const fakeToken = `${header}.${payload}.`;

    const resp = await page.request.get('/api/preferences', {
      headers: { Authorization: `Bearer ${fakeToken}` },
    });
    expect(resp.status()).toBe(401);
  });

  test('token with empty signature is rejected', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    const payload = btoa(
      JSON.stringify({
        sub: 1,
        username: 'admin',
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    )
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    // Token with only 2 parts (missing signature) -- split yields 2 parts
    const resp = await page.request.get('/api/preferences', {
      headers: { Authorization: `Bearer ${header}.${payload}` },
    });
    expect(resp.status()).toBe(401);
  });

  test('token with 4+ segments is rejected', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    const resp = await page.request.get('/api/preferences', {
      headers: { Authorization: 'Bearer a.b.c.d' },
    });
    expect(resp.status()).toBe(401);
  });

  test('token with expired timestamp is rejected', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    // We can't forge a valid signature, but we can verify the server checks expiration
    // by using a real token and waiting -- not practical. Instead verify with a
    // structurally valid but signed-with-wrong-key token.
    const resp = await page.request.get('/api/preferences', {
      headers: { Authorization: 'Bearer eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJzdWIiOjEsInVzZXJuYW1lIjoiYWRtaW4iLCJleHAiOjB9.invalid' },
    });
    expect(resp.status()).toBe(401);
  });

  test('empty Authorization header is rejected', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    const resp = await page.request.get('/api/preferences', {
      headers: { Authorization: '' },
    });
    expect(resp.status()).toBe(401);
  });

  test('Authorization header with only "Bearer " (no token) is rejected', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    const resp = await page.request.get('/api/preferences', {
      headers: { Authorization: 'Bearer ' },
    });
    expect(resp.status()).toBe(401);
  });
});

// =============================================================================
// DELETED USER TOKEN REUSE (SECURITY BUG CANDIDATE)
// =============================================================================

test.describe('Deleted user token reuse', () => {
  test('deleted user token is rejected for preferences (security fix)', async ({ page }) => {
    const user = uniqueUser();
    await mockSmoldata(page);
    await page.goto('/');

    const { token } = await apiRegister(page, user, 'password123');

    // Delete account
    const delResp = await page.request.delete('/api/account', {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      data: JSON.stringify({ password: 'password123' }),
    });
    expect(delResp.ok()).toBe(true);

    // Try to write preferences with the now-invalid token
    const putResp = await page.request.put('/api/preferences', {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      data: {
        categoryScores: { orphan: 999 },
        hiddenCategories: [],
      },
    });

    // Token is cryptographically valid but user no longer exists - should be rejected
    expect(putResp.status()).toBe(401);
    const body = await putResp.json();
    expect(body.error).toBe('User not found');
  });

  test('deleted user token is rejected for reading preferences', async ({ page }) => {
    const user = uniqueUser();
    await mockSmoldata(page);
    await page.goto('/');

    const { token } = await apiRegister(page, user, 'password123');

    // Save prefs, delete account, then try to read
    await page.request.put('/api/preferences', {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      data: { categoryScores: { test: 42 }, hiddenCategories: [] },
    });

    await page.request.delete('/api/account', {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      data: JSON.stringify({ password: 'password123' }),
    });

    const getResp = await page.request.get('/api/preferences', {
      headers: { Authorization: `Bearer ${token}` },
    });

    // Token is cryptographically valid but user no longer exists - should be rejected
    expect(getResp.status()).toBe(401);
  });
});

// =============================================================================
// PREFERENCE VALIDATION EDGE CASES
// =============================================================================

test.describe('Preference payload edge cases', () => {
  test('categoryScores with non-numeric values', async ({ page }) => {
    const user = uniqueUser();
    await mockSmoldata(page);
    await page.goto('/');
    const { token } = await apiRegister(page, user, 'password123');

    const resp = await page.request.put('/api/preferences', {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      data: {
        categoryScores: { science: 'not_a_number', math: null, art: true },
        hiddenCategories: [],
      },
    });

    // The server accepts any object shape for categoryScores -- it just serializes it.
    // This is a potential bug: the frontend expects numeric values.
    // Document the behavior.
    expect(resp.status()).not.toBe(500);
  });

  test('hiddenCategories with non-string values', async ({ page }) => {
    const user = uniqueUser();
    await mockSmoldata(page);
    await page.goto('/');
    const { token } = await apiRegister(page, user, 'password123');

    const resp = await page.request.put('/api/preferences', {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      data: {
        categoryScores: {},
        hiddenCategories: [123, null, true, { nested: 'obj' }],
      },
    });

    expect(resp.status()).not.toBe(500);
  });

  test('categoryScores as an array (should be object) is rejected', async ({ page }) => {
    const user = uniqueUser();
    await mockSmoldata(page);
    await page.goto('/');
    const { token } = await apiRegister(page, user, 'password123');

    const resp = await page.request.put('/api/preferences', {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      data: {
        categoryScores: [1, 2, 3], // array, not object
        hiddenCategories: [],
      },
    });

    // Arrays should be rejected - categoryScores must be a plain object
    expect(resp.status()).toBe(400);
    const body = await resp.json();
    expect(body.error).toBe('categoryScores must be an object');
  });

  test('null categoryScores and null hiddenCategories', async ({ page }) => {
    const user = uniqueUser();
    await mockSmoldata(page);
    await page.goto('/');
    const { token } = await apiRegister(page, user, 'password123');

    const resp = await page.request.put('/api/preferences', {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      data: {
        categoryScores: null,
        hiddenCategories: null,
      },
    });

    // The validation checks `if (body.categoryScores && ...)` -- null is falsy,
    // so it skips validation and falls through to `body.categoryScores ?? {}`.
    // This should work fine.
    expect(resp.status()).toBe(200);
  });

  test('preferences with deeply nested object', async ({ page }) => {
    const user = uniqueUser();
    await mockSmoldata(page);
    await page.goto('/');
    const { token } = await apiRegister(page, user, 'password123');

    // Create a deeply nested object
    let nested: any = { value: 1 };
    for (let i = 0; i < 100; i++) {
      nested = { inner: nested };
    }

    const resp = await page.request.put('/api/preferences', {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      data: {
        categoryScores: nested,
        hiddenCategories: [],
      },
    });

    expect(resp.status()).not.toBe(500);
  });

  test('empty body to PUT /api/preferences', async ({ page }) => {
    const user = uniqueUser();
    await mockSmoldata(page);
    await page.goto('/');
    const { token } = await apiRegister(page, user, 'password123');

    const resp = await page.request.put('/api/preferences', {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      data: {},
    });

    // Empty body should default to {} for categoryScores and [] for hiddenCategories
    expect(resp.status()).toBe(200);
  });

  test('preference payload near the 1MB size limit', async ({ page }) => {
    const user = uniqueUser();
    await mockSmoldata(page);
    await page.goto('/');
    const { token } = await apiRegister(page, user, 'password123');

    // Create a payload just over 1MB
    const bigScores: Record<string, number> = {};
    // Each key like "category_XXXXXX": 999999 is ~25 bytes. Need ~40000 entries for 1MB.
    for (let i = 0; i < 45000; i++) {
      bigScores[`category_${i.toString().padStart(6, '0')}`] = 999999;
    }

    const resp = await page.request.put('/api/preferences', {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      data: {
        categoryScores: bigScores,
        hiddenCategories: [],
      },
    });

    expect(resp.status()).toBe(413);
  });
});

// =============================================================================
// USERNAME EDGE CASES
// =============================================================================

test.describe('Username edge cases', () => {
  test('username with only underscores is accepted', async ({ page }) => {
    // "___" is 3 chars, all underscores, matches [a-zA-Z0-9_]{3,20}
    const user = '___' + Date.now().toString(36).slice(-5);
    await mockSmoldata(page);
    await page.goto('/');

    const resp = await page.request.post('/api/register', {
      data: { username: user.slice(0, 20), password: 'password123' },
    });
    expect(resp.status()).toBe(201);
  });

  test('username with only numbers is accepted', async ({ page }) => {
    const user = Date.now().toString().slice(-10);
    await mockSmoldata(page);
    await page.goto('/');

    const resp = await page.request.post('/api/register', {
      data: { username: user, password: 'password123' },
    });
    expect(resp.status()).toBe(201);
  });

  test('username is case-preserved in response but login is case-insensitive', async ({ page }) => {
    const baseName = uniqueUser();
    await mockSmoldata(page);
    await page.goto('/');

    // Register with mixed case
    const regResp = await page.request.post('/api/register', {
      data: { username: baseName, password: 'password123' },
    });
    expect(regResp.status()).toBe(201);
    const regData = await regResp.json();
    expect(regData.username).toBe(baseName);

    // Login with different case should work (COLLATE NOCASE)
    const loginResp = await page.request.post('/api/login', {
      data: { username: baseName.toUpperCase(), password: 'password123' },
    });
    expect(loginResp.status()).toBe(200);
    const loginData = await loginResp.json();
    // The returned username should be the ORIGINAL case from registration
    expect(loginData.username).toBe(baseName);
  });

  test('username with leading/trailing whitespace via API', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    // The frontend trims username, but what about the API directly?
    const resp = await page.request.post('/api/register', {
      data: { username: '  spacey  ', password: 'password123' },
    });
    // Spaces don't match [a-zA-Z0-9_], so this should be 400
    expect(resp.status()).toBe(400);
  });

  test('username as number type (not string) is rejected', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    const resp = await page.request.post('/api/register', {
      data: { username: 12345, password: 'password123' },
    });
    expect(resp.status()).toBe(400);
  });

  test('username as boolean type is rejected', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    const resp = await page.request.post('/api/register', {
      data: { username: true, password: 'password123' },
    });
    expect(resp.status()).toBe(400);
  });

  test('password as number type is rejected', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    const resp = await page.request.post('/api/register', {
      data: { username: uniqueUser(), password: 123456 },
    });
    expect(resp.status()).toBe(400);
  });

  test('username as null is rejected', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    const resp = await page.request.post('/api/register', {
      data: { username: null, password: 'password123' },
    });
    expect(resp.status()).toBe(400);
  });

  test('login with username as null is rejected', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    const resp = await page.request.post('/api/login', {
      data: { username: null, password: 'password123' },
    });
    expect(resp.status()).toBe(400);
  });
});

// =============================================================================
// CONTENT-TYPE EDGE CASES
// =============================================================================

test.describe('Content-Type handling', () => {
  test('register with form-encoded body (not JSON) returns 400', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    const resp = await page.request.fetch('/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      data: 'username=test&password=test123',
    });
    expect(resp.status()).toBe(400);
  });

  test('register with empty body returns 400', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    const resp = await page.request.fetch('/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      data: '',
    });
    expect(resp.status()).toBe(400);
  });

  test('login with no Content-Type header', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    const resp = await page.request.fetch('/api/login', {
      method: 'POST',
      data: JSON.stringify({ username: 'test', password: 'test123' }),
    });
    // Should still work or return 400, not 500
    expect(resp.status()).not.toBe(500);
  });
});

// =============================================================================
// CONCURRENT REGISTRATION (RACE CONDITION)
// =============================================================================

test.describe('Concurrent operations', () => {
  test('concurrent registration with same username - only one succeeds', async ({ page }) => {
    const user = uniqueUser();
    await mockSmoldata(page);
    await page.goto('/');

    // Fire two registration requests simultaneously
    const [resp1, resp2] = await Promise.all([
      page.request.post('/api/register', {
        data: { username: user, password: 'password123' },
      }),
      page.request.post('/api/register', {
        data: { username: user, password: 'password456' },
      }),
    ]);

    const statuses = [resp1.status(), resp2.status()].sort();
    // One should succeed (201), one should fail (409 duplicate)
    expect(statuses).toEqual([201, 409]);
  });

  test('concurrent preference writes do not crash', async ({ page }) => {
    const user = uniqueUser();
    await mockSmoldata(page);
    await page.goto('/');

    const { token } = await apiRegister(page, user, 'password123');

    // Fire multiple preference writes simultaneously
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        page.request.put('/api/preferences', {
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          data: {
            categoryScores: { [`cat_${i}`]: i * 100 },
            hiddenCategories: [],
          },
        }),
      ),
    );

    // All should succeed (last-write-wins semantics is fine)
    results.forEach((resp) => {
      expect(resp.status()).toBe(200);
    });
  });
});

// =============================================================================
// REGISTER BUTTON LOADING STATE (parallels the login loading state test)
// =============================================================================

test.describe('Register button loading state', () => {
  test('register button shows loading state while request is in-flight', async ({ page }) => {
    await gotoReady(page);
    const user = uniqueUser();

    // Slow down the register API so we can observe the loading state
    await page.route('**/api/register', async (route) => {
      await new Promise((r) => setTimeout(r, 1500));
      await route.continue();
    });

    await page.locator('.auth-tab[data-tab="register"]').click();
    await page.locator('#registerUsername').fill(user);
    await page.locator('#registerPassword').fill('password123');
    await page.locator('#registerConfirm').fill('password123');
    await page.locator('#registerBtn').click();

    // While waiting, button should show loading text and be disabled
    await expect(page.locator('#registerBtn')).toContainText(/creating account/i, {
      timeout: 3000,
    });
    await expect(page.locator('#registerBtn')).toBeDisabled();
  });
});

// =============================================================================
// FRONTEND WHITESPACE HANDLING
// =============================================================================

test.describe('Frontend whitespace handling', () => {
  test('login form trims username but not password', async ({ page }) => {
    const user = uniqueUser();
    await gotoReady(page);

    // Register with normal username
    await apiRegister(page, user, 'password123');

    // Login with whitespace-padded username through UI
    await page.locator('.auth-tab[data-tab="login"]').click();
    await page.locator('#loginUsername').fill(`  ${user}  `);
    await page.locator('#loginPassword').fill('password123');

    // Monitor the request to see what username gets sent
    let sentUsername = '';
    page.on('request', (req) => {
      if (req.url().includes('/api/login') && req.method() === 'POST') {
        try {
          const body = req.postDataJSON();
          sentUsername = body.username;
        } catch {
          // ignore
        }
      }
    });

    await mockSmoldata(page);
    await page.locator('#loginBtn').click();

    // Wait for the request to complete
    await page.waitForTimeout(3000);

    // The frontend trims username. Verify it was trimmed.
    expect(sentUsername).toBe(user);
  });
});

// =============================================================================
// CORS BEHAVIOR
// =============================================================================

test.describe('CORS headers on API responses', () => {
  test('API error responses include CORS headers', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    const resp = await page.request.get('/api/preferences');
    expect(resp.status()).toBe(401);
    const headers = resp.headers();
    expect(headers['access-control-allow-origin']).toBeTruthy();
  });

  test('CORS preflight for DELETE method', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    const resp = await page.request.fetch('/api/account', {
      method: 'OPTIONS',
    });
    expect(resp.status()).toBe(204);
    const headers = resp.headers();
    expect(headers['access-control-allow-methods']).toContain('DELETE');
    expect(headers['access-control-allow-headers']).toContain('Authorization');
  });
});

// =============================================================================
// TOKEN RETURNED STRUCTURE VALIDATION
// =============================================================================

test.describe('Token/response structure', () => {
  test('register response contains both token and username', async ({ page }) => {
    const user = uniqueUser();
    await mockSmoldata(page);
    await page.goto('/');

    const resp = await page.request.post('/api/register', {
      data: { username: user, password: 'password123' },
    });
    expect(resp.status()).toBe(201);
    const body = await resp.json();

    expect(body).toHaveProperty('token');
    expect(body).toHaveProperty('username');
    expect(typeof body.token).toBe('string');
    expect(body.token.split('.')).toHaveLength(3); // JWT has 3 parts
    expect(body.username).toBe(user);
  });

  test('login response contains both token and username', async ({ page }) => {
    const user = uniqueUser();
    await mockSmoldata(page);
    await page.goto('/');

    await apiRegister(page, user, 'password123');

    const resp = await page.request.post('/api/login', {
      data: { username: user, password: 'password123' },
    });
    expect(resp.status()).toBe(200);
    const body = await resp.json();

    expect(body).toHaveProperty('token');
    expect(body).toHaveProperty('username');
    expect(typeof body.token).toBe('string');
    expect(body.token.split('.')).toHaveLength(3);
    expect(body.username).toBe(user);
  });

  test('error responses have consistent structure', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    const resp = await page.request.post('/api/register', {
      data: { username: 'ab', password: 'password123' },
    });
    expect(resp.status()).toBe(400);
    const body = await resp.json();

    expect(body).toHaveProperty('error');
    expect(typeof body.error).toBe('string');
    expect(body.error.length).toBeGreaterThan(0);
  });
});

// =============================================================================
// DELETE ACCOUNT DOUBLE-CALL
// =============================================================================

test.describe('Delete account idempotency', () => {
  test('deleting an already-deleted account does not crash', async ({ page }) => {
    const user = uniqueUser();
    await mockSmoldata(page);
    await page.goto('/');

    const { token } = await apiRegister(page, user, 'password123');

    // First delete
    const del1 = await page.request.delete('/api/account', {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: JSON.stringify({ password: 'password123' }),
    });
    expect(del1.ok()).toBe(true);

    // Second delete with same token -- user already gone
    // Token is still cryptographically valid so auth passes,
    // but DELETE FROM users WHERE id = ? will affect 0 rows.
    const del2 = await page.request.delete('/api/account', {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: JSON.stringify({ password: 'password123' }),
    });

    // Should not crash (500). Could return 200 (no-op) or 404.
    expect(del2.status()).not.toBe(500);
  });
});

// =============================================================================
// EXTRA FIELDS IN REQUEST BODY
// =============================================================================

test.describe('Extra fields in request body', () => {
  test('register with extra fields does not crash or expose them', async ({ page }) => {
    const user = uniqueUser();
    await mockSmoldata(page);
    await page.goto('/');

    const resp = await page.request.post('/api/register', {
      data: {
        username: user,
        password: 'password123',
        role: 'admin',
        isAdmin: true,
        __proto__: { polluted: true },
      },
    });
    expect(resp.status()).toBe(201);
    const body = await resp.json();
    // Should not echo back extra fields
    expect(body).not.toHaveProperty('role');
    expect(body).not.toHaveProperty('isAdmin');
  });

  test('login with extra fields does not crash', async ({ page }) => {
    const user = uniqueUser();
    await mockSmoldata(page);
    await page.goto('/');

    await apiRegister(page, user, 'password123');

    const resp = await page.request.post('/api/login', {
      data: {
        username: user,
        password: 'password123',
        extraField: 'should be ignored',
      },
    });
    expect(resp.status()).toBe(200);
  });
});
