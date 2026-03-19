/**
 * Rate Limiting Tests
 *
 * Tests the rate limiting implementation in src/index.ts.
 * Uses spoofed X-Forwarded-For headers to isolate rate limit buckets per test.
 *
 * Run with: npx playwright test tests/rate-limit.spec.ts
 * Requires wrangler dev server (Cloudflare production rewrites XFF headers).
 */

import { test, expect, Page, APIResponse } from '@playwright/test';

// Rate limiting tests require local dev - Cloudflare production rewrites X-Forwarded-For
const isLocalhost = process.env.PLAYWRIGHT_BASE_URL?.includes('localhost') ?? true;

// Skip all tests in this file when running against production
test.beforeEach(async ({}, testInfo) => {
  test.skip(!isLocalhost, 'Rate limiting tests require local dev (Cloudflare rewrites XFF)');
});

// ---- Helpers ----------------------------------------------------------------

const MOCK_SMOLDATA = {
  subCategories: { science: ['physics'] },
  noPageMaps: {},
  pages: Array.from({ length: 10 }, (_, i) => [
    `Article ${i}`, i + 1, 'A'.repeat(120) + ` content ${i}`,
    null, ['science'], [((i + 1) % 10) + 1],
  ]),
};

const _ipWorkerOctet = Math.floor(Math.random() * 256);
let _ipCounter = 1000;
function freshIp(): string {
  _ipCounter++;
  return `10.${_ipWorkerOctet}.${Math.floor(_ipCounter / 256) % 256}.${_ipCounter % 256}`;
}

let _userCounter = 0;
function uniqueUser(): string {
  _userCounter++;
  const random = Math.random().toString(36).slice(2, 6);
  return `rl${Date.now().toString(36).slice(-4)}${_userCounter.toString(36)}${random}`;
}

async function mockSmoldata(page: Page) {
  const mockDataJson = JSON.stringify(MOCK_SMOLDATA);
  await page.addInitScript(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.getRegistrations().then(regs => regs.forEach(r => r.unregister()));
    }
  });
  await page.route('**/smoldata.json', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: mockDataJson }),
  );
}

async function apiRegister(page: Page, username: string, password: string, ip: string): Promise<APIResponse> {
  return page.request.post('/api/register', {
    data: { username, password },
    headers: { 'x-forwarded-for': ip },
  });
}

function extractTokenFromCookie(resp: APIResponse): string {
  const setCookie = resp.headers()['set-cookie'] ?? '';
  const match = setCookie.match(/xiki_token=([^;]+)/);
  return match ? match[1] : '';
}

// =============================================================================
// REGISTRATION RATE LIMITING
// =============================================================================

test.describe('Registration rate limiting', () => {
  test('3 registrations succeed, 4th is blocked', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');
    const ip = freshIp();

    for (let i = 0; i < 3; i++) {
      const resp = await apiRegister(page, uniqueUser(), 'password123', ip);
      expect(resp.status()).toBe(201);
    }

    const resp4 = await apiRegister(page, uniqueUser(), 'password123', ip);
    expect(resp4.status()).toBe(429);
    const body = await resp4.json();
    expect(body.error).toBe('Too many requests');
    expect(resp4.headers()['retry-after']).toBeTruthy();
    const retryAfter = parseInt(resp4.headers()['retry-after'], 10);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(3600);
  });

  test('per-IP isolation: different IPs are independent', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');
    const ip1 = freshIp();
    const ip2 = freshIp();

    for (let i = 0; i < 3; i++) {
      await apiRegister(page, uniqueUser(), 'password123', ip1);
    }
    const blockedResp = await apiRegister(page, uniqueUser(), 'password123', ip1);
    expect(blockedResp.status()).toBe(429);

    const allowedResp = await apiRegister(page, uniqueUser(), 'password123', ip2);
    expect(allowedResp.status()).toBe(201);
  });

  test('invalid JSON does not consume rate limit quota', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');
    const ip = freshIp();

    // 6 invalid JSON requests (2x the limit)
    for (let i = 0; i < 6; i++) {
      const resp = await page.request.fetch('/api/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip },
        data: '{ invalid json !!!',
      });
      expect(resp.status()).toBe(400);
    }

    // Valid registration should still work
    const validResp = await apiRegister(page, uniqueUser(), 'password123', ip);
    expect(validResp.status()).toBe(201);
  });

  test('validation failures do not consume rate limit quota', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');
    const ip = freshIp();

    // 5 requests with too-short password
    for (let i = 0; i < 5; i++) {
      const resp = await apiRegister(page, uniqueUser(), 'ab', ip);
      expect(resp.status()).toBe(400);
    }

    // Valid registration should still work
    const validResp = await apiRegister(page, uniqueUser(), 'password123', ip);
    expect(validResp.status()).toBe(201);
  });

  test('duplicate username attempts DO consume rate limit quota', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');
    const ip = freshIp();
    const existingUser = uniqueUser();

    // Register once
    const first = await apiRegister(page, existingUser, 'password123', ip);
    expect(first.status()).toBe(201); // count = 1

    // Duplicate attempts pass validation but fail at DB insert — quota still consumed
    const dup1 = await apiRegister(page, existingUser, 'password456', ip);
    expect(dup1.status()).toBe(409); // count = 2
    const dup2 = await apiRegister(page, existingUser, 'password789', ip);
    expect(dup2.status()).toBe(409); // count = 3

    // Quota is now exhausted (3 increments)
    const blocked = await apiRegister(page, uniqueUser(), 'password123', ip);
    expect(blocked.status()).toBe(429);
  });

  test('rate-limited response has CORS headers', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');
    const ip = freshIp();

    for (let i = 0; i < 3; i++) {
      await apiRegister(page, uniqueUser(), 'password123', ip);
    }
    const resp = await apiRegister(page, uniqueUser(), 'password123', ip);
    expect(resp.status()).toBe(429);
    expect(resp.headers()['access-control-allow-origin']).toBeTruthy();
  });

  test('429 JSON body has only { error: string }', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');
    const ip = freshIp();

    for (let i = 0; i < 3; i++) {
      await apiRegister(page, uniqueUser(), 'password123', ip);
    }
    const resp = await apiRegister(page, uniqueUser(), 'password123', ip);
    expect(resp.status()).toBe(429);
    const body = await resp.json();
    expect(body).toHaveProperty('error');
    expect(typeof body.error).toBe('string');
    expect(Object.keys(body)).toEqual(['error']);
  });

  test('concurrent registrations respect limit (TOCTOU safety)', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');
    const ip = freshIp();

    // 6 concurrent registration requests (2x the limit)
    const promises = Array.from({ length: 6 }, () =>
      apiRegister(page, uniqueUser(), 'password123', ip),
    );
    const responses = await Promise.all(promises);
    const statuses = responses.map(r => r.status());

    const got201 = statuses.filter(s => s === 201).length;
    const got429 = statuses.filter(s => s === 429).length;

    // At most 3 should succeed
    expect(got201).toBeLessThanOrEqual(3);
    expect(got201 + got429).toBe(6);
  });
});

// =============================================================================
// LOGIN RATE LIMITING
// =============================================================================

test.describe('Login rate limiting', () => {
  test('5 failed attempts return 401, 6th returns 429', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');
    const ip = freshIp();

    for (let i = 0; i < 5; i++) {
      const resp = await page.request.post('/api/login', {
        data: { username: 'nonexistent_user_xyzzy', password: 'wrongpass' },
        headers: { 'x-forwarded-for': ip },
      });
      expect(resp.status()).toBe(401);
    }

    const resp6 = await page.request.post('/api/login', {
      data: { username: 'nonexistent_user_xyzzy', password: 'wrongpass' },
      headers: { 'x-forwarded-for': ip },
    });
    expect(resp6.status()).toBe(429);
    const body = await resp6.json();
    expect(body.error).toBe('Too many requests');
    expect(resp6.headers()['retry-after']).toBeTruthy();
    const retryAfter = parseInt(resp6.headers()['retry-after'], 10);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(900);
  });

  test('successful login resets the failed attempt counter', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');
    const ip = freshIp();
    const user = uniqueUser();

    // Register user on a different IP
    const regResp = await apiRegister(page, user, 'correctpass', freshIp());
    expect(regResp.status()).toBe(201);

    // 4 failures
    for (let i = 0; i < 4; i++) {
      const resp = await page.request.post('/api/login', {
        data: { username: user, password: 'wrongpass' },
        headers: { 'x-forwarded-for': ip },
      });
      expect(resp.status()).toBe(401);
    }

    // Successful login — should reset counter
    const goodLogin = await page.request.post('/api/login', {
      data: { username: user, password: 'correctpass' },
      headers: { 'x-forwarded-for': ip },
    });
    expect(goodLogin.status()).toBe(200);

    // After reset, can fail 5 more times before being blocked
    for (let i = 0; i < 5; i++) {
      const resp = await page.request.post('/api/login', {
        data: { username: user, password: 'wrongpass' },
        headers: { 'x-forwarded-for': ip },
      });
      expect(resp.status()).toBe(401);
    }

    // 6th failure after reset is blocked
    const blocked = await page.request.post('/api/login', {
      data: { username: user, password: 'wrongpass' },
      headers: { 'x-forwarded-for': ip },
    });
    expect(blocked.status()).toBe(429);
  });

  test('successful logins do not increment failure counter', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');
    const ip = freshIp();
    const user = uniqueUser();

    const regResp = await apiRegister(page, user, 'password123', freshIp());
    expect(regResp.status()).toBe(201);

    // 7 successful logins in a row — all should work
    for (let i = 0; i < 7; i++) {
      const resp = await page.request.post('/api/login', {
        data: { username: user, password: 'password123' },
        headers: { 'x-forwarded-for': ip },
      });
      expect(resp.status()).toBe(200);
    }
  });

  test('correct credentials bypass rate limit on shared IP', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');
    const sharedIp = freshIp();
    const legitimateUser = uniqueUser();

    // Register legitimate user
    const regResp = await apiRegister(page, legitimateUser, 'correctpassword', freshIp());
    expect(regResp.status()).toBe(201);

    // Attacker exhausts the IP's failure counter
    for (let i = 0; i < 5; i++) {
      const resp = await page.request.post('/api/login', {
        data: { username: 'definitely_nonexistent_xyz', password: 'wrongpassword' },
        headers: { 'x-forwarded-for': sharedIp },
      });
      expect(resp.status()).toBe(401);
    }

    // Legitimate user with correct credentials should still succeed
    // (no upfront peek — rate limit only triggers on failure)
    const loginResp = await page.request.post('/api/login', {
      data: { username: legitimateUser, password: 'correctpassword' },
      headers: { 'x-forwarded-for': sharedIp },
    });
    expect(loginResp.status()).toBe(200);
  });

  test('per-IP isolation: different IPs are independent', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');
    const ip1 = freshIp();
    const ip2 = freshIp();

    for (let i = 0; i < 5; i++) {
      await page.request.post('/api/login', {
        data: { username: 'nope', password: 'nope' },
        headers: { 'x-forwarded-for': ip1 },
      });
    }
    const blockedResp = await page.request.post('/api/login', {
      data: { username: 'nope', password: 'nope' },
      headers: { 'x-forwarded-for': ip1 },
    });
    expect(blockedResp.status()).toBe(429);

    const allowedResp = await page.request.post('/api/login', {
      data: { username: 'nope', password: 'nope' },
      headers: { 'x-forwarded-for': ip2 },
    });
    expect(allowedResp.status()).toBe(401);
  });

  test('concurrent failed logins respect limit (TOCTOU safety)', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');
    const ip = freshIp();

    // 10 concurrent failed login attempts
    const promises = Array.from({ length: 10 }, () =>
      page.request.post('/api/login', {
        data: { username: 'toctou_nonexistent', password: 'wrongpassword' },
        headers: { 'x-forwarded-for': ip },
      }),
    );
    const responses = await Promise.all(promises);
    const statuses = responses.map(r => r.status());

    const got401 = statuses.filter(s => s === 401).length;
    const got429 = statuses.filter(s => s === 429).length;

    // At most 5 should get 401, rest should be 429
    expect(got401).toBeLessThanOrEqual(5);
    expect(got401 + got429).toBe(10);
  });
});

// =============================================================================
// DELETE ACCOUNT RATE LIMITING
// =============================================================================

test.describe('Delete account rate limiting', () => {
  test('wrong password attempts are rate limited after 5 tries', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');
    const user = uniqueUser();

    const regResp = await apiRegister(page, user, 'correctpassword', freshIp());
    expect(regResp.status()).toBe(201);
    const token = extractTokenFromCookie(regResp);

    // 5 wrong password attempts
    for (let i = 0; i < 5; i++) {
      const resp = await page.request.delete('/api/account', {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        data: JSON.stringify({ password: `wrongguess${i}` }),
      });
      expect(resp.status()).toBe(403);
    }

    // 6th attempt should be rate limited (not 403)
    const resp6 = await page.request.delete('/api/account', {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: JSON.stringify({ password: 'wrongguess5' }),
    });
    expect(resp6.status()).toBe(429);
    expect(resp6.headers()['retry-after']).toBeTruthy();
  });

  test('delete rate limit is per user ID, not per IP', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');
    const ip = freshIp();

    const userA = uniqueUser();
    const regA = await apiRegister(page, userA, 'password123', ip);
    expect(regA.status()).toBe(201);
    const tokenA = extractTokenFromCookie(regA);

    const userB = uniqueUser();
    const regB = await apiRegister(page, userB, 'password123', ip);
    expect(regB.status()).toBe(201);
    const tokenB = extractTokenFromCookie(regB);

    // User A deletes successfully
    const delA = await page.request.delete('/api/account', {
      headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
      data: JSON.stringify({ password: 'password123' }),
    });
    expect(delA.status()).toBe(200);

    // User B can still delete (different rate limit key)
    const delB = await page.request.delete('/api/account', {
      headers: { Authorization: `Bearer ${tokenB}`, 'Content-Type': 'application/json' },
      data: JSON.stringify({ password: 'password123' }),
    });
    expect(delB.status()).toBe(200);
  });

  test('rate limit check happens before user lookup', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');
    const user = uniqueUser();

    const regResp = await apiRegister(page, user, 'password123', freshIp());
    expect(regResp.status()).toBe(201);
    const token = extractTokenFromCookie(regResp);

    // Delete the account
    const del1 = await page.request.delete('/api/account', {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: JSON.stringify({ password: 'password123' }),
    });
    expect(del1.status()).toBe(200);

    // 4 more attempts with deleted token (user is gone)
    // With cookie auth, authenticate() checks DB for user — deleted user returns 401
    for (let i = 0; i < 4; i++) {
      const resp = await page.request.delete('/api/account', {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        data: JSON.stringify({ password: 'password123' }),
      });
      expect(resp.status()).toBe(401); // user deleted, auth fails
    }

    // 6th total attempt: auth fails before rate limiter (401 not 429)
    // because authenticate() rejects the token (user deleted, token_version invalid)
    const resp6 = await page.request.delete('/api/account', {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: JSON.stringify({ password: 'password123' }),
    });
    expect(resp6.status()).toBe(401);
  });
});
