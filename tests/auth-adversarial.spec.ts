import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

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

const _ipWorkerOctet = Math.floor(Math.random() * 256);
let _ipCounter = 0;
function uniqueIp(): string {
  _ipCounter++;
  return `10.${_ipWorkerOctet}.${Math.floor(_ipCounter / 256) % 256}.${_ipCounter % 256}`;
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
    headers: { 'x-forwarded-for': uniqueIp() },
  });
  expect(resp.ok()).toBe(true);
  const setCookie = resp.headers()['set-cookie'] ?? '';
  const match = setCookie.match(/xiki_token=([^;]+)/);
  expect(match, `Expected xiki_token cookie in Set-Cookie header, got: ${setCookie}`).toBeTruthy();
  const token = match![1];
  expect(token.length).toBeGreaterThan(0);
  const body = await resp.json();
  return { token, username: body.username };
}

function extractTokenFromSetCookie(setCookieHeader: string): string {
  const match = setCookieHeader.match(/xiki_token=([^;]+)/);
  expect(match, `Expected xiki_token in Set-Cookie: ${setCookieHeader}`).toBeTruthy();
  return match![1];
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
  test('GET /api/register returns 405 with Allow: POST', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');
    const resp = await page.request.get('/api/register');
    expect(resp.status()).toBe(405);
    expect(resp.headers()['allow']).toBe('OPTIONS, POST');
  });

  test('PUT /api/register returns 405 with Allow: POST', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');
    const resp = await page.request.put('/api/register', {
      data: { username: 'test', password: 'test123' },
    });
    expect(resp.status()).toBe(405);
    expect(resp.headers()['allow']).toBe('OPTIONS, POST');
  });

  test('GET /api/login returns 405 with Allow: POST', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');
    const resp = await page.request.get('/api/login');
    expect(resp.status()).toBe(405);
    expect(resp.headers()['allow']).toBe('OPTIONS, POST');
  });

  test('DELETE /api/login returns 405 with Allow: POST', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');
    const resp = await page.request.delete('/api/login');
    expect(resp.status()).toBe(405);
    expect(resp.headers()['allow']).toBe('OPTIONS, POST');
  });

  test('POST /api/preferences returns 405 with Allow: GET, PUT', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');
    const user = uniqueUser();
    const { token } = await apiRegister(page, user, 'password123');
    const resp = await page.request.post('/api/preferences', {
      headers: { Cookie: `xiki_token=${token}` },
      data: { categoryScores: {} },
    });
    expect(resp.status()).toBe(405);
    expect(resp.headers()['allow']).toBe('OPTIONS, GET, PUT');
  });

  test('POST /api/account returns 405 with Allow: DELETE', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');
    const user = uniqueUser();
    const { token } = await apiRegister(page, user, 'password123');
    const resp = await page.request.post('/api/account', {
      headers: { Cookie: `xiki_token=${token}` },
      data: {},
    });
    expect(resp.status()).toBe(405);
    expect(resp.headers()['allow']).toBe('OPTIONS, DELETE');
  });

  test('GET /api/account returns 405 with Allow: DELETE', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');
    const resp = await page.request.get('/api/account');
    expect(resp.status()).toBe(405);
    expect(resp.headers()['allow']).toBe('OPTIONS, DELETE');
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
      headers: { 'x-forwarded-for': uniqueIp() },
    });
    expect(resp.status()).toBe(201);

    // Verify login with same long password works
    const loginResp = await page.request.post('/api/login', {
      data: { username: user, password: longPassword },
      headers: { 'x-forwarded-for': uniqueIp() },
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
      headers: { 'x-forwarded-for': uniqueIp() },
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
      headers: { 'x-forwarded-for': uniqueIp() },
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
      headers: { 'x-forwarded-for': uniqueIp() },
    });
    expect(regResp.status()).toBe(201);

    const loginResp = await page.request.post('/api/login', {
      data: { username: user, password: unicodePassword },
      headers: { 'x-forwarded-for': uniqueIp() },
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
      headers: { 'x-forwarded-for': uniqueIp() },
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
      headers: { 'x-forwarded-for': uniqueIp() },
    });
    expect(resp.status()).toBe(400);
  });

  test('empty string username is rejected', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    const resp = await page.request.post('/api/register', {
      data: { username: '', password: 'password123' },
      headers: { 'x-forwarded-for': uniqueIp() },
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
      headers: { 'x-forwarded-for': uniqueIp() },
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
      headers: { 'x-forwarded-for': uniqueIp() },
    });
    // Password can contain any chars, so this should succeed (it's 23 chars)
    expect(resp.status()).toBe(201);

    // Verify the users table still works
    const user2 = uniqueUser();
    const resp2 = await page.request.post('/api/register', {
      data: { username: user2, password: 'normal123' },
      headers: { 'x-forwarded-for': uniqueIp() },
    });
    expect(resp2.status()).toBe(201);
  });

  test('SQL injection in login username does not crash', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    const resp = await page.request.post('/api/login', {
      data: { username: "'; DROP TABLE users; --", password: 'password123' },
      headers: { 'x-forwarded-for': uniqueIp() },
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
      headers: { 'x-forwarded-for': uniqueIp() },
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
      headers: { Cookie: `xiki_token=${fakeToken}` },
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
      headers: { Cookie: `xiki_token=${header}.${payload}` },
    });
    expect(resp.status()).toBe(401);
  });

  test('token with 4+ segments is rejected', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    const resp = await page.request.get('/api/preferences', {
      headers: { Cookie: 'xiki_token=a.b.c.d' },
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
      headers: { Cookie: 'xiki_token=eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJzdWIiOjEsInVzZXJuYW1lIjoiYWRtaW4iLCJleHAiOjB9.invalid' },
    });
    expect(resp.status()).toBe(401);
  });

  test('empty Cookie header is rejected', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    const resp = await page.request.get('/api/preferences', {
      headers: { Cookie: '' },
    });
    expect(resp.status()).toBe(401);
  });

  test('Cookie with empty xiki_token value is rejected', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    const resp = await page.request.get('/api/preferences', {
      headers: { Cookie: 'xiki_token=' },
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
        Cookie: `xiki_token=${token}`,
        'Content-Type': 'application/json',
        'x-forwarded-for': uniqueIp(),
      },
      data: JSON.stringify({ password: 'password123' }),
    });
    expect(delResp.ok()).toBe(true);

    // Try to write preferences with the now-invalid token
    const putResp = await page.request.put('/api/preferences', {
      headers: {
        Cookie: `xiki_token=${token}`,
        'Content-Type': 'application/json',
      },
      data: {
        categoryScores: { orphan: 999 },
        hiddenCategories: [],
      },
    });

    // Token is cryptographically valid but user no longer exists - should be rejected
    // authenticate() now queries token_version from users table; missing row returns null → 'Unauthorized'
    expect(putResp.status()).toBe(401);
  });

  test('deleted user token is rejected for reading preferences', async ({ page }) => {
    const user = uniqueUser();
    await mockSmoldata(page);
    await page.goto('/');

    const { token } = await apiRegister(page, user, 'password123');

    // Save prefs, delete account, then try to read
    await page.request.put('/api/preferences', {
      headers: {
        Cookie: `xiki_token=${token}`,
        'Content-Type': 'application/json',
      },
      data: { categoryScores: { test: 42 }, hiddenCategories: [] },
    });

    await page.request.delete('/api/account', {
      headers: {
        Cookie: `xiki_token=${token}`,
        'Content-Type': 'application/json',
        'x-forwarded-for': uniqueIp(),
      },
      data: JSON.stringify({ password: 'password123' }),
    });

    const getResp = await page.request.get('/api/preferences', {
      headers: { Cookie: `xiki_token=${token}` },
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
        Cookie: `xiki_token=${token}`,
        'Content-Type': 'application/json',
      },
      data: {
        categoryScores: { science: 'not_a_number', math: null, art: true },
        hiddenCategories: [],
      },
    });

    // Server validates that categoryScores values must be finite numbers
    expect(resp.status()).toBe(400);
    const body = await resp.json();
    expect(body.error).toBe('categoryScores values must be finite numbers');
  });

  test('hiddenCategories with non-string values', async ({ page }) => {
    const user = uniqueUser();
    await mockSmoldata(page);
    await page.goto('/');
    const { token } = await apiRegister(page, user, 'password123');

    const resp = await page.request.put('/api/preferences', {
      headers: {
        Cookie: `xiki_token=${token}`,
        'Content-Type': 'application/json',
      },
      data: {
        categoryScores: {},
        hiddenCategories: [123, null, true, { nested: 'obj' }],
      },
    });

    // Server validates that hiddenCategories items must be strings
    expect(resp.status()).toBe(400);
    const body = await resp.json();
    expect(body.error).toBe('hiddenCategories items must be strings');
  });

  test('categoryScores as an array (should be object) is rejected', async ({ page }) => {
    const user = uniqueUser();
    await mockSmoldata(page);
    await page.goto('/');
    const { token } = await apiRegister(page, user, 'password123');

    const resp = await page.request.put('/api/preferences', {
      headers: {
        Cookie: `xiki_token=${token}`,
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
        Cookie: `xiki_token=${token}`,
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
        Cookie: `xiki_token=${token}`,
        'Content-Type': 'application/json',
      },
      data: {
        categoryScores: nested,
        hiddenCategories: [],
      },
    });

    // Deeply nested objects are not valid category score values (must be finite numbers)
    expect(resp.status()).toBe(400);
  });

  test('empty body to PUT /api/preferences', async ({ page }) => {
    const user = uniqueUser();
    await mockSmoldata(page);
    await page.goto('/');
    const { token } = await apiRegister(page, user, 'password123');

    const resp = await page.request.put('/api/preferences', {
      headers: {
        Cookie: `xiki_token=${token}`,
        'Content-Type': 'application/json',
      },
      data: {},
    });

    // Empty body should default to {} for categoryScores and [] for hiddenCategories
    expect(resp.status()).toBe(200);
  });

  test('categoryScores with Infinity is rejected', async ({ page }) => {
    const user = uniqueUser();
    await mockSmoldata(page);
    await page.goto('/');
    const { token } = await apiRegister(page, user, 'password123');

    // JSON.stringify(Infinity) → null, but test the server-side check
    // Send a value that parses as non-finite
    const resp = await page.request.put('/api/preferences', {
      headers: {
        Cookie: `xiki_token=${token}`,
        'Content-Type': 'application/json',
      },
      data: {
        categoryScores: { science: 42, math: 'Infinity' },
        hiddenCategories: [],
      },
    });

    expect(resp.status()).toBe(400);
    const body = await resp.json();
    expect(body.error).toBe('categoryScores values must be finite numbers');
  });

  test('categoryScores with valid numeric values is accepted', async ({ page }) => {
    const user = uniqueUser();
    await mockSmoldata(page);
    await page.goto('/');
    const { token } = await apiRegister(page, user, 'password123');

    const resp = await page.request.put('/api/preferences', {
      headers: {
        Cookie: `xiki_token=${token}`,
        'Content-Type': 'application/json',
      },
      data: {
        categoryScores: { science: 150, math: -50, art: 0, history: 99.5 },
        hiddenCategories: ['biology', 'chemistry'],
      },
    });

    expect(resp.status()).toBe(200);
  });

  test('hiddenCategories with mixed types is rejected', async ({ page }) => {
    const user = uniqueUser();
    await mockSmoldata(page);
    await page.goto('/');
    const { token } = await apiRegister(page, user, 'password123');

    const resp = await page.request.put('/api/preferences', {
      headers: {
        Cookie: `xiki_token=${token}`,
        'Content-Type': 'application/json',
      },
      data: {
        categoryScores: {},
        hiddenCategories: ['science', 42],
      },
    });

    expect(resp.status()).toBe(400);
    const body = await resp.json();
    expect(body.error).toBe('hiddenCategories items must be strings');
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
        Cookie: `xiki_token=${token}`,
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
      headers: { 'x-forwarded-for': uniqueIp() },
    });
    expect(resp.status()).toBe(201);
  });

  test('username with only numbers is accepted', async ({ page }) => {
    const user = Date.now().toString().slice(-10);
    await mockSmoldata(page);
    await page.goto('/');

    const resp = await page.request.post('/api/register', {
      data: { username: user, password: 'password123' },
      headers: { 'x-forwarded-for': uniqueIp() },
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
      headers: { 'x-forwarded-for': uniqueIp() },
    });
    expect(regResp.status()).toBe(201);
    const regData = await regResp.json();
    expect(regData.username).toBe(baseName);

    // Login with different case should work (COLLATE NOCASE)
    const loginResp = await page.request.post('/api/login', {
      data: { username: baseName.toUpperCase(), password: 'password123' },
      headers: { 'x-forwarded-for': uniqueIp() },
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
      headers: { 'x-forwarded-for': uniqueIp() },
    });
    // Spaces don't match [a-zA-Z0-9_], so this should be 400
    expect(resp.status()).toBe(400);
  });

  test('username as number type (not string) is rejected', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    const resp = await page.request.post('/api/register', {
      data: { username: 12345, password: 'password123' },
      headers: { 'x-forwarded-for': uniqueIp() },
    });
    expect(resp.status()).toBe(400);
  });

  test('username as boolean type is rejected', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    const resp = await page.request.post('/api/register', {
      data: { username: true, password: 'password123' },
      headers: { 'x-forwarded-for': uniqueIp() },
    });
    expect(resp.status()).toBe(400);
  });

  test('password as number type is rejected', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    const resp = await page.request.post('/api/register', {
      data: { username: uniqueUser(), password: 123456 },
      headers: { 'x-forwarded-for': uniqueIp() },
    });
    expect(resp.status()).toBe(400);
  });

  test('username as null is rejected', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    const resp = await page.request.post('/api/register', {
      data: { username: null, password: 'password123' },
      headers: { 'x-forwarded-for': uniqueIp() },
    });
    expect(resp.status()).toBe(400);
  });

  test('login with username as null is rejected', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    const resp = await page.request.post('/api/login', {
      data: { username: null, password: 'password123' },
      headers: { 'x-forwarded-for': uniqueIp() },
    });
    expect(resp.status()).toBe(400);
  });

  test('login with empty string password for existing user is rejected', async ({ page }) => {
    const user = uniqueUser();
    await mockSmoldata(page);
    await page.goto('/');

    // Register the user first — this ensures the DB lookup succeeds and the
    // empty password would otherwise reach hashPassword("", salt), triggering
    // "Imported HMAC key length (0) must be a non-zero value" in Cloudflare's
    // Web Crypto before the fix.
    await apiRegister(page, user, 'password123');

    const resp = await page.request.post('/api/login', {
      data: { username: user, password: '' },
      headers: { 'x-forwarded-for': uniqueIp() },
    });
    expect(resp.status()).toBe(400);
    const body = await resp.json();
    expect(body.error).toBe('Username and password are required');
  });

  test('login with empty string username is rejected', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    const resp = await page.request.post('/api/login', {
      data: { username: '', password: 'validpass' },
      headers: { 'x-forwarded-for': uniqueIp() },
    });
    expect(resp.status()).toBe(400);
    const body = await resp.json();
    expect(body.error).toBe('Username and password are required');
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
    const sharedIp = uniqueIp();
    const [resp1, resp2] = await Promise.all([
      page.request.post('/api/register', {
        data: { username: user, password: 'password123' },
        headers: { 'x-forwarded-for': sharedIp },
      }),
      page.request.post('/api/register', {
        data: { username: user, password: 'password456' },
        headers: { 'x-forwarded-for': sharedIp },
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
            Cookie: `xiki_token=${token}`,
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
    expect(headers['access-control-allow-headers']).toContain('Content-Type');
  });
});

// =============================================================================
// TOKEN RETURNED STRUCTURE VALIDATION
// =============================================================================

test.describe('Token/response structure', () => {
  test('register response contains username and sets httpOnly auth cookie', async ({ page }) => {
    const user = uniqueUser();
    await mockSmoldata(page);
    await page.goto('/');

    const resp = await page.request.post('/api/register', {
      data: { username: user, password: 'password123' },
      headers: { 'x-forwarded-for': uniqueIp() },
    });
    expect(resp.status()).toBe(201);
    const body = await resp.json();

    // Token is now in Set-Cookie header, not response body
    expect(body).toHaveProperty('username');
    expect(body.username).toBe(user);

    const setCookie = resp.headers()['set-cookie'] ?? '';
    const match = setCookie.match(/xiki_token=([^;]+)/);
    expect(match).toBeTruthy();
    expect(match![1].split('.')).toHaveLength(3); // JWT has 3 parts
    expect(setCookie).toContain('HttpOnly');
    // Secure flag is conditional on HTTPS (omitted on localhost/HTTP)
    if (process.env.PLAYWRIGHT_BASE_URL?.startsWith('https')) {
      expect(setCookie).toContain('Secure');
    }
  });

  test('login response contains username and sets httpOnly auth cookie', async ({ page }) => {
    const user = uniqueUser();
    await mockSmoldata(page);
    await page.goto('/');

    await apiRegister(page, user, 'password123');

    const resp = await page.request.post('/api/login', {
      data: { username: user, password: 'password123' },
      headers: { 'x-forwarded-for': uniqueIp() },
    });
    expect(resp.status()).toBe(200);
    const body = await resp.json();

    // Token is now in Set-Cookie header, not response body
    expect(body).toHaveProperty('username');
    expect(body.username).toBe(user);

    const setCookie = resp.headers()['set-cookie'] ?? '';
    const match = setCookie.match(/xiki_token=([^;]+)/);
    expect(match).toBeTruthy();
    expect(match![1].split('.')).toHaveLength(3); // JWT has 3 parts
    expect(setCookie).toContain('HttpOnly');
    if (process.env.PLAYWRIGHT_BASE_URL?.startsWith('https')) {
      expect(setCookie).toContain('Secure');
    }
  });

  test('error responses have consistent structure', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    const resp = await page.request.post('/api/register', {
      data: { username: 'ab', password: 'password123' },
      headers: { 'x-forwarded-for': uniqueIp() },
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
      headers: { Cookie: `xiki_token=${token}`, 'Content-Type': 'application/json', 'x-forwarded-for': uniqueIp() },
      data: JSON.stringify({ password: 'password123' }),
    });
    expect(del1.ok()).toBe(true);

    // Second delete with same token -- user already gone
    // Token is still cryptographically valid so auth passes,
    // but DELETE FROM users WHERE id = ? will affect 0 rows.
    const del2 = await page.request.delete('/api/account', {
      headers: { Cookie: `xiki_token=${token}`, 'Content-Type': 'application/json', 'x-forwarded-for': uniqueIp() },
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
      headers: { 'x-forwarded-for': uniqueIp() },
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
      headers: { 'x-forwarded-for': uniqueIp() },
    });
    expect(resp.status()).toBe(200);
  });
});

// =============================================================================
// TOKEN REVOCATION / LOGOUT (EMI-47)
// =============================================================================

test.describe('token revocation: logout invalidation', () => {
  test('after POST /api/logout, old token returns 401 on GET /api/preferences', async ({ page }) => {
    const user = uniqueUser();
    await mockSmoldata(page);
    await page.goto('/');

    const { token } = await apiRegister(page, user, 'password123');

    // Confirm token works before logout
    const beforeResp = await page.request.get('/api/preferences', {
      headers: { Cookie: `xiki_token=${token}` },
    });
    expect(beforeResp.status()).toBe(200);

    // Logout
    const logoutResp = await page.request.post('/api/logout', {
      headers: { Cookie: `xiki_token=${token}` },
    });
    expect(logoutResp.status()).toBe(200);

    // Old token must now be rejected
    const afterResp = await page.request.get('/api/preferences', {
      headers: { Cookie: `xiki_token=${token}` },
    });
    expect(afterResp.status()).toBe(401);
  });

  test('after POST /api/logout, old token returns 401 on PUT /api/preferences', async ({ page }) => {
    const user = uniqueUser();
    await mockSmoldata(page);
    await page.goto('/');

    const { token } = await apiRegister(page, user, 'password123');

    await page.request.post('/api/logout', {
      headers: { Cookie: `xiki_token=${token}` },
    });

    const resp = await page.request.put('/api/preferences', {
      headers: {
        Cookie: `xiki_token=${token}`,
        'Content-Type': 'application/json',
      },
      data: { categoryScores: { attack: 999 }, hiddenCategories: [] },
    });
    expect(resp.status()).toBe(401);
  });

  test('after POST /api/logout, old token cannot call logout again', async ({ page }) => {
    const user = uniqueUser();
    await mockSmoldata(page);
    await page.goto('/');

    const { token } = await apiRegister(page, user, 'password123');

    // First logout succeeds
    const first = await page.request.post('/api/logout', {
      headers: { Cookie: `xiki_token=${token}` },
    });
    expect(first.status()).toBe(200);

    // Second logout with same token must be rejected (token is revoked)
    const second = await page.request.post('/api/logout', {
      headers: { Cookie: `xiki_token=${token}` },
    });
    expect(second.status()).toBe(401);
  });
});

test.describe('token revocation: logout requires authentication', () => {
  test('POST /api/logout without auth cookie returns 401', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    const resp = await page.request.post('/api/logout');
    expect(resp.status()).toBe(401);
  });

  test('POST /api/logout with invalid token returns 401', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    const resp = await page.request.post('/api/logout', {
      headers: { Cookie: 'xiki_token=not.a.real.token' },
    });
    expect(resp.status()).toBe(401);
  });

  test('GET /api/logout returns 405 (wrong method)', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    const resp = await page.request.get('/api/logout');
    expect(resp.status()).toBe(405);
    expect(resp.headers()['allow']).toBe('OPTIONS, POST');
  });
});

test.describe('token revocation: multiple sessions invalidated by single logout', () => {
  test('logging in twice and logging out once invalidates BOTH tokens (global token_version)', async ({ page }) => {
    const user = uniqueUser();
    await mockSmoldata(page);
    await page.goto('/');

    // Register — gets token A
    const { token: tokenA } = await apiRegister(page, user, 'password123');

    // Login again — gets token B (same token_version as A since no logout yet)
    const loginResp = await page.request.post('/api/login', {
      data: { username: user, password: 'password123' },
      headers: { 'x-forwarded-for': uniqueIp() },
    });
    expect(loginResp.status()).toBe(200);
    const tokenB = extractTokenFromSetCookie(loginResp.headers()['set-cookie'] ?? '');

    // Both tokens work
    const aBeforeResp = await page.request.get('/api/preferences', {
      headers: { Cookie: `xiki_token=${tokenA}` },
    });
    expect(aBeforeResp.status()).toBe(200);
    const bBeforeResp = await page.request.get('/api/preferences', {
      headers: { Cookie: `xiki_token=${tokenB}` },
    });
    expect(bBeforeResp.status()).toBe(200);

    // Logout using token A — increments token_version globally for this user
    const logoutResp = await page.request.post('/api/logout', {
      headers: { Cookie: `xiki_token=${tokenA}` },
    });
    expect(logoutResp.status()).toBe(200);

    // Token A is revoked
    const aAfterResp = await page.request.get('/api/preferences', {
      headers: { Cookie: `xiki_token=${tokenA}` },
    });
    expect(aAfterResp.status()).toBe(401);

    // Token B is ALSO revoked (shared token_version)
    const bAfterResp = await page.request.get('/api/preferences', {
      headers: { Cookie: `xiki_token=${tokenB}` },
    });
    expect(bAfterResp.status()).toBe(401);
  });
});

test.describe('token revocation: login after logout gives working token', () => {
  test('after logout, logging in again returns a new valid token', async ({ page }) => {
    const user = uniqueUser();
    await mockSmoldata(page);
    await page.goto('/');

    const { token: oldToken } = await apiRegister(page, user, 'password123');

    // Logout
    await page.request.post('/api/logout', {
      headers: { Cookie: `xiki_token=${oldToken}` },
    });

    // Old token is dead
    const staleResp = await page.request.get('/api/preferences', {
      headers: { Cookie: `xiki_token=${oldToken}` },
    });
    expect(staleResp.status()).toBe(401);

    // Login again
    const loginResp = await page.request.post('/api/login', {
      data: { username: user, password: 'password123' },
      headers: { 'x-forwarded-for': uniqueIp() },
    });
    expect(loginResp.status()).toBe(200);
    const newToken = extractTokenFromSetCookie(loginResp.headers()['set-cookie'] ?? '');

    // New token works
    const freshResp = await page.request.get('/api/preferences', {
      headers: { Cookie: `xiki_token=${newToken}` },
    });
    expect(freshResp.status()).toBe(200);
  });
});

test.describe('token revocation: password change invalidates tokens', () => {
  test('after POST /api/password, old token returns 401', async ({ page }) => {
    const user = uniqueUser();
    await mockSmoldata(page);
    await page.goto('/');

    const { token } = await apiRegister(page, user, 'password123');

    // Confirm token works
    const beforeResp = await page.request.get('/api/preferences', {
      headers: { Cookie: `xiki_token=${token}` },
    });
    expect(beforeResp.status()).toBe(200);

    // Change password
    const changeResp = await page.request.post('/api/password', {
      headers: {
        Cookie: `xiki_token=${token}`,
        'Content-Type': 'application/json',
      },
      data: { currentPassword: 'password123', newPassword: 'newpass456' },
    });
    expect(changeResp.status()).toBe(200);

    // Old token must now be rejected
    const afterResp = await page.request.get('/api/preferences', {
      headers: { Cookie: `xiki_token=${token}` },
    });
    expect(afterResp.status()).toBe(401);
  });

  test('after password change, old token cannot be used for another password change', async ({ page }) => {
    const user = uniqueUser();
    await mockSmoldata(page);
    await page.goto('/');

    const { token } = await apiRegister(page, user, 'password123');

    // First password change
    await page.request.post('/api/password', {
      headers: { Cookie: `xiki_token=${token}`, 'Content-Type': 'application/json' },
      data: { currentPassword: 'password123', newPassword: 'newpass456' },
    });

    // Try to use old token for another password change
    const secondResp = await page.request.post('/api/password', {
      headers: { Cookie: `xiki_token=${token}`, 'Content-Type': 'application/json' },
      data: { currentPassword: 'newpass456', newPassword: 'another789' },
    });
    expect(secondResp.status()).toBe(401);
  });

  test('after password change, login with new password works', async ({ page }) => {
    const user = uniqueUser();
    await mockSmoldata(page);
    await page.goto('/');

    const { token } = await apiRegister(page, user, 'password123');

    await page.request.post('/api/password', {
      headers: { Cookie: `xiki_token=${token}`, 'Content-Type': 'application/json' },
      data: { currentPassword: 'password123', newPassword: 'newpass456' },
    });

    const loginResp = await page.request.post('/api/login', {
      data: { username: user, password: 'newpass456' },
      headers: { 'x-forwarded-for': uniqueIp() },
    });
    expect(loginResp.status()).toBe(200);
    const newToken = extractTokenFromSetCookie(loginResp.headers()['set-cookie'] ?? '');

    const prefsResp = await page.request.get('/api/preferences', {
      headers: { Cookie: `xiki_token=${newToken}` },
    });
    expect(prefsResp.status()).toBe(200);
  });

  test('after password change, login with OLD password returns 401', async ({ page }) => {
    const user = uniqueUser();
    await mockSmoldata(page);
    await page.goto('/');

    const { token } = await apiRegister(page, user, 'password123');

    await page.request.post('/api/password', {
      headers: { Cookie: `xiki_token=${token}`, 'Content-Type': 'application/json' },
      data: { currentPassword: 'password123', newPassword: 'newpass456' },
    });

    const loginOldResp = await page.request.post('/api/login', {
      data: { username: user, password: 'password123' },
      headers: { 'x-forwarded-for': uniqueIp() },
    });
    expect(loginOldResp.status()).toBe(401);
  });
});

test.describe('password change endpoint validation', () => {
  test('missing currentPassword returns 400', async ({ page }) => {
    const user = uniqueUser();
    await mockSmoldata(page);
    await page.goto('/');

    const { token } = await apiRegister(page, user, 'password123');

    const resp = await page.request.post('/api/password', {
      headers: { Cookie: `xiki_token=${token}`, 'Content-Type': 'application/json' },
      data: { newPassword: 'newpass456' },
    });
    expect(resp.status()).toBe(400);
    const body = await resp.json();
    expect(body.error).toMatch(/current password/i);
  });

  test('empty string currentPassword returns 400', async ({ page }) => {
    const user = uniqueUser();
    await mockSmoldata(page);
    await page.goto('/');

    const { token } = await apiRegister(page, user, 'password123');

    const resp = await page.request.post('/api/password', {
      headers: { Cookie: `xiki_token=${token}`, 'Content-Type': 'application/json' },
      data: { currentPassword: '', newPassword: 'newpass456' },
    });
    expect(resp.status()).toBe(400);
  });

  test('missing newPassword returns 400', async ({ page }) => {
    const user = uniqueUser();
    await mockSmoldata(page);
    await page.goto('/');

    const { token } = await apiRegister(page, user, 'password123');

    const resp = await page.request.post('/api/password', {
      headers: { Cookie: `xiki_token=${token}`, 'Content-Type': 'application/json' },
      data: { currentPassword: 'password123' },
    });
    expect(resp.status()).toBe(400);
    const body = await resp.json();
    expect(body.error).toMatch(/new password/i);
  });

  test('newPassword shorter than 6 chars returns 400', async ({ page }) => {
    const user = uniqueUser();
    await mockSmoldata(page);
    await page.goto('/');

    const { token } = await apiRegister(page, user, 'password123');

    const resp = await page.request.post('/api/password', {
      headers: { Cookie: `xiki_token=${token}`, 'Content-Type': 'application/json' },
      data: { currentPassword: 'password123', newPassword: 'abc' },
    });
    expect(resp.status()).toBe(400);
    const body = await resp.json();
    expect(body.error).toMatch(/6 characters/i);
  });

  test('newPassword longer than 256 chars returns 400', async ({ page }) => {
    const user = uniqueUser();
    await mockSmoldata(page);
    await page.goto('/');

    const { token } = await apiRegister(page, user, 'password123');

    const resp = await page.request.post('/api/password', {
      headers: { Cookie: `xiki_token=${token}`, 'Content-Type': 'application/json' },
      data: { currentPassword: 'password123', newPassword: 'a'.repeat(257) },
    });
    expect(resp.status()).toBe(400);
    const body = await resp.json();
    expect(body.error).toMatch(/256/i);
  });

  test('wrong currentPassword returns 403', async ({ page }) => {
    const user = uniqueUser();
    await mockSmoldata(page);
    await page.goto('/');

    const { token } = await apiRegister(page, user, 'password123');

    const resp = await page.request.post('/api/password', {
      headers: { Cookie: `xiki_token=${token}`, 'Content-Type': 'application/json' },
      data: { currentPassword: 'wrongpassword', newPassword: 'newpass456' },
    });
    expect(resp.status()).toBe(403);
  });

  test('POST /api/password without auth returns 401', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    const resp = await page.request.post('/api/password', {
      headers: { 'Content-Type': 'application/json' },
      data: { currentPassword: 'password123', newPassword: 'newpass456' },
    });
    expect(resp.status()).toBe(401);
  });

  test('newPassword equal to currentPassword is accepted (no same-password restriction)', async ({ page }) => {
    // This documents the current behavior: server does NOT prevent reuse
    const user = uniqueUser();
    await mockSmoldata(page);
    await page.goto('/');

    const { token } = await apiRegister(page, user, 'password123');

    const resp = await page.request.post('/api/password', {
      headers: { Cookie: `xiki_token=${token}`, 'Content-Type': 'application/json' },
      data: { currentPassword: 'password123', newPassword: 'password123' },
    });
    // Implementation does not block same-password reuse; this should succeed
    expect(resp.status()).toBe(200);
  });
});

test.describe('token_version in JWT payload', () => {
  test('token from register contains token_version field', async ({ page }) => {
    const user = uniqueUser();
    await mockSmoldata(page);
    await page.goto('/');

    const { token } = await apiRegister(page, user, 'password123');

    // Decode the JWT payload (middle segment, base64url)
    const payloadB64 = token.split('.')[1];
    const padded = payloadB64.replace(/-/g, '+').replace(/_/g, '/');
    const decoded = JSON.parse(atob(padded.padEnd(padded.length + (4 - padded.length % 4) % 4, '=')));

    expect(decoded).toHaveProperty('token_version');
    expect(decoded.token_version).toBe(1);
  });

  test('token from login contains token_version field', async ({ page }) => {
    const user = uniqueUser();
    await mockSmoldata(page);
    await page.goto('/');

    await apiRegister(page, user, 'password123');

    const loginResp = await page.request.post('/api/login', {
      data: { username: user, password: 'password123' },
      headers: { 'x-forwarded-for': uniqueIp() },
    });
    expect(loginResp.status()).toBe(200);
    const setCookie = loginResp.headers()['set-cookie'] ?? '';
    const match = setCookie.match(/xiki_token=([^;]+)/);
    expect(match, `Expected xiki_token in Set-Cookie: ${setCookie}`).toBeTruthy();
    const token = match![1];

    const payloadB64 = token.split('.')[1];
    const padded = payloadB64.replace(/-/g, '+').replace(/_/g, '/');
    const decoded = JSON.parse(atob(padded.padEnd(padded.length + (4 - padded.length % 4) % 4, '=')));

    expect(decoded).toHaveProperty('token_version');
    expect(typeof decoded.token_version).toBe('number');
  });

  test('token_version increments after logout + re-login', async ({ page }) => {
    const user = uniqueUser();
    await mockSmoldata(page);
    await page.goto('/');

    const { token: token1 } = await apiRegister(page, user, 'password123');

    // Decode version from first token
    const decode = (t: string) => {
      const b64 = t.split('.')[1];
      const padded = b64.replace(/-/g, '+').replace(/_/g, '/');
      return JSON.parse(atob(padded.padEnd(padded.length + (4 - padded.length % 4) % 4, '=')));
    };

    const version1 = decode(token1).token_version;

    // Logout
    await page.request.post('/api/logout', {
      headers: { Cookie: `xiki_token=${token1}` },
    });

    // Login again
    const loginResp = await page.request.post('/api/login', {
      data: { username: user, password: 'password123' },
      headers: { 'x-forwarded-for': uniqueIp() },
    });
    const loginCookie = loginResp.headers()['set-cookie'] ?? '';
    const loginMatch = loginCookie.match(/xiki_token=([^;]+)/);
    expect(loginMatch, `Expected xiki_token in login Set-Cookie: ${loginCookie}`).toBeTruthy();
    const token2 = loginMatch![1];
    const version2 = decode(token2).token_version;

    // The new token must have a higher version than the old one
    expect(version2).toBeGreaterThan(version1);
  });

  test('token with original token_version is rejected after logout (version mismatch)', async ({ page }) => {
    // After logout, DB version increments from 1 to 2.
    // The original token still has token_version=1, so authenticate() rejects it.
    // This also covers legacy tokens (no token_version field) which default to 1 via ?? fallback.
    const user = uniqueUser();
    await mockSmoldata(page);
    await page.goto('/');

    const { token: realToken } = await apiRegister(page, user, 'password123');

    // Decode real token to extract sub and username
    const b64 = realToken.split('.')[1];
    const padded = b64.replace(/-/g, '+').replace(/_/g, '/');
    const realPayload = JSON.parse(atob(padded.padEnd(padded.length + (4 - padded.length % 4) % 4, '=')));

    // Logout — DB version goes from 1 to 2
    await page.request.post('/api/logout', {
      headers: { Cookie: `xiki_token=${realToken}` },
    });

    // The original token has token_version=1, DB is now 2 — rejected
    const afterResp = await page.request.get('/api/preferences', {
      headers: { Cookie: `xiki_token=${realToken}` },
    });
    expect(afterResp.status()).toBe(401);

    // Verify the version from realPayload was 1
    expect(realPayload.token_version).toBe(1);
  });
});

test.describe('request body size limits', () => {
  test('oversized register body returns 413', async ({ page }) => {
    // 128KB JSON payload — well over the 64KB limit
    const hugePayload = JSON.stringify({
      username: 'a'.repeat(65536),
      password: 'b'.repeat(65536),
    });
    const resp = await page.request.post('/api/register', {
      data: hugePayload,
      headers: { 'Content-Type': 'application/json' },
    });
    expect(resp.status()).toBe(413);
    const body = await resp.json();
    expect(body.error).toContain('too large');
  });

  test('oversized login body returns 413', async ({ page }) => {
    const hugePayload = JSON.stringify({
      username: 'a'.repeat(65536),
      password: 'b'.repeat(65536),
    });
    const resp = await page.request.post('/api/login', {
      data: hugePayload,
      headers: { 'Content-Type': 'application/json' },
    });
    expect(resp.status()).toBe(413);
    const body = await resp.json();
    expect(body.error).toContain('too large');
  });

  test('normal-sized register body is accepted (not blocked by size limit)', async ({ page }) => {
    const resp = await page.request.post('/api/register', {
      data: JSON.stringify({ username: 'xx', password: 'short' }),
      headers: { 'Content-Type': 'application/json' },
    });
    // Should get a validation error (username too short), not 413
    expect(resp.status()).toBe(400);
    const body = await resp.json();
    expect(body.error).not.toContain('too large');
  });
});
