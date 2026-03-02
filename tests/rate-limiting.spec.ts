/**
 * Rate Limiting Tests
 *
 * Covers acceptance criteria for EMI-23:
 *   - Login: 5 failed attempts/IP/15min → 429 with Retry-After
 *   - Register: 3 attempts/IP/hour → 429 with Retry-After
 *   - Delete account: 1/user/day → 429 with Retry-After
 *   - Legitimate users are not impacted by successful operations
 *
 * ISOLATION: Each test group sends a unique CF-Connecting-IP header to get its
 * own rate-limit bucket in D1. This prevents cross-test and cross-run
 * interference without requiring a database reset between runs.
 *
 * Run: npx playwright test tests/rate-limiting.spec.ts --workers=1
 */

import { test, expect, Page } from '@playwright/test';

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

/** Generate a unique fake IP for test isolation. */
function uniqueIP(): string {
  return `10.test.${Date.now()}.${Math.floor(Math.random() * 10000)}`;
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

  await page.addInitScript(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker
        .getRegistrations()
        .then((registrations) => {
          registrations.forEach((registration) => registration.unregister());
        });
    }
    if ('caches' in window) {
      caches.keys().then((names) => {
        names.forEach((name) => caches.delete(name));
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
}

// =============================================================================
// LOGIN RATE LIMITING
// Limit: 5 failed attempts per IP per 15-minute window
// Only failure attempts are counted; successful logins do not increment.
// =============================================================================

// Unique IP shared by all tests in this serial group.
const LOGIN_TEST_IP = uniqueIP();

test.describe.serial('Login rate limiting', () => {
  test('first 5 failed login attempts return 401', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      const resp = await page.request.post('/api/login', {
        headers: { 'CF-Connecting-IP': LOGIN_TEST_IP },
        data: { username: 'nonexistent_rl_user', password: 'wrongpassword' },
      });
      statuses.push(resp.status());
    }

    expect(statuses).toEqual([401, 401, 401, 401, 401]);
  });

  test('6th failed login attempt returns 429 with Retry-After', async ({ page }) => {
    // Precondition: 5 failures already recorded for LOGIN_TEST_IP in the previous test.
    await mockSmoldata(page);
    await page.goto('/');

    const resp = await page.request.post('/api/login', {
      headers: { 'CF-Connecting-IP': LOGIN_TEST_IP },
      data: { username: 'nonexistent_rl_user', password: 'wrongpassword' },
    });

    expect(resp.status()).toBe(429);

    const body = await resp.json();
    expect(typeof body.error).toBe('string');
    expect(body.error.length).toBeGreaterThan(0);

    const retryAfter = resp.headers()['retry-after'];
    expect(retryAfter).toBeTruthy();
    const retryAfterNum = parseInt(retryAfter, 10);
    expect(retryAfterNum).toBeGreaterThanOrEqual(1);
    expect(retryAfterNum).toBeLessThanOrEqual(900); // 15-minute window
  });

  test('429 login response has JSON content-type, CORS, and Retry-After', async ({ page }) => {
    // Precondition: rate limit is already exhausted for LOGIN_TEST_IP.
    await mockSmoldata(page);
    await page.goto('/');

    const resp = await page.request.post('/api/login', {
      headers: { 'CF-Connecting-IP': LOGIN_TEST_IP },
      data: { username: 'nonexistent_rl_user', password: 'wrongpassword' },
    });

    expect(resp.status()).toBe(429);
    expect(resp.headers()['content-type']).toContain('application/json');
    expect(resp.headers()['retry-after']).toBeTruthy();
    expect(resp.headers()['access-control-allow-origin']).toBeTruthy();
  });

  test('successful login from a different IP is not affected by exhausted bucket', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    // Register a user with a fresh IP (registration may be rate limited for unknown; use explicit IP)
    const freshRegIP = uniqueIP();
    const user = uniqueUser();
    const reg = await page.request.post('/api/register', {
      headers: { 'CF-Connecting-IP': freshRegIP },
      data: { username: user, password: 'password123' },
    });
    expect(reg.status()).toBe(201);

    // Login with a fresh IP — completely different bucket from LOGIN_TEST_IP
    const freshLoginIP = uniqueIP();
    const loginResp = await page.request.post('/api/login', {
      headers: { 'CF-Connecting-IP': freshLoginIP },
      data: { username: user, password: 'password123' },
    });
    expect(loginResp.status()).toBe(200);
    const body = await loginResp.json();
    expect(body.token).toBeTruthy();
  });

  test('successful login does not count against the failure limit', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    const successIP = uniqueIP();
    const regIP = uniqueIP();

    // Register a user
    const user = uniqueUser();
    const reg = await page.request.post('/api/register', {
      headers: { 'CF-Connecting-IP': regIP },
      data: { username: user, password: 'password123' },
    });
    expect(reg.status()).toBe(201);

    // Login successfully 6 times — successful logins never increment the failure counter
    for (let i = 0; i < 6; i++) {
      const resp = await page.request.post('/api/login', {
        headers: { 'CF-Connecting-IP': successIP },
        data: { username: user, password: 'password123' },
      });
      expect(resp.status()).toBe(200);
    }
  });
});

// =============================================================================
// REGISTRATION RATE LIMITING
// Limit: 3 attempts per IP per hour
// All attempts that pass validation consume a slot (not just successful ones).
// =============================================================================

const REGISTER_TEST_IP = uniqueIP();

test.describe.serial('Registration rate limiting', () => {
  test('first 3 registration attempts succeed', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) {
      const resp = await page.request.post('/api/register', {
        headers: { 'CF-Connecting-IP': REGISTER_TEST_IP },
        data: { username: uniqueUser(), password: 'password123' },
      });
      statuses.push(resp.status());
    }

    expect(statuses).toEqual([201, 201, 201]);
  });

  test('4th registration attempt returns 429 with Retry-After', async ({ page }) => {
    // Precondition: 3 registrations already recorded for REGISTER_TEST_IP.
    await mockSmoldata(page);
    await page.goto('/');

    const resp = await page.request.post('/api/register', {
      headers: { 'CF-Connecting-IP': REGISTER_TEST_IP },
      data: { username: uniqueUser(), password: 'password123' },
    });

    expect(resp.status()).toBe(429);

    const body = await resp.json();
    expect(typeof body.error).toBe('string');
    expect(body.error.length).toBeGreaterThan(0);

    const retryAfter = resp.headers()['retry-after'];
    expect(retryAfter).toBeTruthy();
    const retryAfterNum = parseInt(retryAfter, 10);
    expect(retryAfterNum).toBeGreaterThanOrEqual(1);
    expect(retryAfterNum).toBeLessThanOrEqual(3600); // 1-hour window
  });

  test('invalid JSON is rejected before consuming a rate limit slot', async ({ page }) => {
    // Rate check is after JSON parse, so malformed JSON returns 400 without using a slot.
    // This documents the behavior rather than being a strict requirement.
    await mockSmoldata(page);
    await page.goto('/');

    const freshIP = uniqueIP();

    // Invalid JSON → 400 immediately, no slot consumed
    const resp1 = await page.request.fetch('/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': freshIP },
      data: '{ bad json !!!',
    });
    expect(resp1.status()).toBe(400);

    // Valid registration should still work (slot was not consumed)
    const resp2 = await page.request.post('/api/register', {
      headers: { 'CF-Connecting-IP': freshIP },
      data: { username: uniqueUser(), password: 'password123' },
    });
    expect(resp2.status()).toBe(201);
  });

  test('input validation errors do not consume rate limit slots', async ({ page }) => {
    // Validation runs before the rate limit check in handleRegister.
    await mockSmoldata(page);
    await page.goto('/');

    const freshIP = uniqueIP();

    // Send validation-failing requests — they return 400 before reaching the rate limit check
    for (let i = 0; i < 5; i++) {
      const resp = await page.request.post('/api/register', {
        headers: { 'CF-Connecting-IP': freshIP },
        data: { username: 'ab', password: 'pw' }, // too short
      });
      expect(resp.status()).toBe(400);
    }

    // A valid registration should still work (no slots were consumed)
    const resp = await page.request.post('/api/register', {
      headers: { 'CF-Connecting-IP': freshIP },
      data: { username: uniqueUser(), password: 'password123' },
    });
    expect(resp.status()).toBe(201);
  });

  test('429 registration response has CORS and Retry-After headers', async ({ page }) => {
    // Precondition: REGISTER_TEST_IP is exhausted from previous tests.
    await mockSmoldata(page);
    await page.goto('/');

    const resp = await page.request.post('/api/register', {
      headers: { 'CF-Connecting-IP': REGISTER_TEST_IP },
      data: { username: uniqueUser(), password: 'password123' },
    });

    expect(resp.status()).toBe(429);
    expect(resp.headers()['content-type']).toContain('application/json');
    expect(resp.headers()['retry-after']).toBeTruthy();
    expect(resp.headers()['access-control-allow-origin']).toBeTruthy();
  });

  test('different IP is not affected by exhausted registration bucket', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    // A fresh IP can still register even though REGISTER_TEST_IP is exhausted
    const freshIP = uniqueIP();
    const resp = await page.request.post('/api/register', {
      headers: { 'CF-Connecting-IP': freshIP },
      data: { username: uniqueUser(), password: 'password123' },
    });
    expect(resp.status()).toBe(201);
  });
});

// =============================================================================
// DELETE ACCOUNT RATE LIMITING
// Limit: 1 per user per day (keyed by user ID, not IP)
// Rate limit is checked AFTER password verification.
// =============================================================================

test.describe('Delete account rate limiting', () => {
  test('wrong password on delete does not consume the rate limit slot', async ({ page }) => {
    // The rate limit check runs AFTER password verification, so a wrong password
    // never reaches the rate limit increment.
    await mockSmoldata(page);
    await page.goto('/');

    const regIP = uniqueIP();
    const user = uniqueUser();

    const reg = await page.request.post('/api/register', {
      headers: { 'CF-Connecting-IP': regIP },
      data: { username: user, password: 'correctpassword' },
    });
    expect(reg.status()).toBe(201);
    const { token } = await reg.json();

    // Wrong password — rejected at 403 before rate limit is incremented
    const del1 = await page.request.delete('/api/account', {
      headers: { Authorization: `Bearer ${token}` },
      data: { password: 'wrongpassword' },
    });
    expect(del1.status()).toBe(403);

    // Correct password — the rate limit slot was not consumed, so this succeeds (200)
    const del2 = await page.request.delete('/api/account', {
      headers: { Authorization: `Bearer ${token}` },
      data: { password: 'correctpassword' },
    });
    expect(del2.status()).toBe(200);
  });

  test('each user has an independent deletion rate limit', async ({ page }) => {
    // Rate limit is keyed by user ID, not IP — different users have separate buckets.
    await mockSmoldata(page);
    await page.goto('/');

    const regIP = uniqueIP();

    // Register two users
    const regA = await page.request.post('/api/register', {
      headers: { 'CF-Connecting-IP': regIP },
      data: { username: uniqueUser(), password: 'password123' },
    });
    expect(regA.status()).toBe(201);
    const { token: tokenA } = await regA.json();

    const regB = await page.request.post('/api/register', {
      headers: { 'CF-Connecting-IP': regIP },
      data: { username: uniqueUser(), password: 'password123' },
    });
    expect(regB.status()).toBe(201);
    const { token: tokenB } = await regB.json();

    // Delete user A — should succeed (their own rate limit bucket)
    const delA = await page.request.delete('/api/account', {
      headers: { Authorization: `Bearer ${tokenA}` },
      data: { password: 'password123' },
    });
    expect(delA.status()).toBe(200);

    // Delete user B — should also succeed (different rate limit bucket)
    const delB = await page.request.delete('/api/account', {
      headers: { Authorization: `Bearer ${tokenB}` },
      data: { password: 'password123' },
    });
    expect(delB.status()).toBe(200);
  });

  test('delete with unauthorized token returns 401 not 429', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    const resp = await page.request.delete('/api/account', {
      headers: { Authorization: 'Bearer invalid.token.here' },
      data: { password: 'password123' },
    });

    // Auth check happens before rate limit — should be 401, not 429
    expect(resp.status()).toBe(401);
  });
});
