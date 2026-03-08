import { test, expect, Page } from '@playwright/test';

// ---- Helpers ----------------------------------------------------------------

const MOCK_SMOLDATA = {
  subCategories: { science: ['physics'] },
  noPageMaps: {},
  pages: Array.from({ length: 10 }, (_, i) => [
    `Article ${i}`, i + 1, 'A'.repeat(120) + ` content ${i}`,
    null, ['science'], [((i + 1) % 10) + 1],
  ]),
};

let _ipCounter = 1000; // Start at 1000 to avoid collisions with other test files
function uniqueIp(): string {
  _ipCounter++;
  return `10.${Math.floor(_ipCounter / 65536) % 256}.${Math.floor(_ipCounter / 256) % 256}.${_ipCounter % 256}`;
}

let _userCounter = 0;
function uniqueUser(): string {
  _userCounter++;
  return `rl${Date.now().toString(36).slice(-4)}${_userCounter.toString(36)}`;
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

async function apiRegister(page: Page, username: string, password: string, ip: string): Promise<Response> {
  return page.request.post('/api/register', {
    data: { username, password },
    headers: { 'x-forwarded-for': ip },
  });
}

// =============================================================================
// REGISTRATION RATE LIMITING
// =============================================================================

test.describe('Registration rate limiting', () => {
  test('3rd registration attempt succeeds, 4th is blocked', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');
    const ip = uniqueIp();

    // 3 successful registrations
    for (let i = 1; i <= 3; i++) {
      const resp = await apiRegister(page, uniqueUser(), 'password123', ip);
      expect(resp.status()).toBe(201);
    }

    // 4th should be rate limited
    const resp4 = await apiRegister(page, uniqueUser(), 'password123', ip);
    expect(resp4.status()).toBe(429);
    const body = await resp4.json();
    expect(body.error).toBe('Too many requests');
    expect(resp4.headers()['retry-after']).toBeTruthy();
    const retryAfter = parseInt(resp4.headers()['retry-after'], 10);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(3600);
  });

  test('rate limit is per-IP: different IPs are independent', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');
    const ip1 = uniqueIp();
    const ip2 = uniqueIp();

    // Exhaust ip1
    for (let i = 0; i < 3; i++) {
      await apiRegister(page, uniqueUser(), 'password123', ip1);
    }
    const blockedResp = await apiRegister(page, uniqueUser(), 'password123', ip1);
    expect(blockedResp.status()).toBe(429);

    // ip2 is unaffected
    const allowedResp = await apiRegister(page, uniqueUser(), 'password123', ip2);
    expect(allowedResp.status()).toBe(201);
  });

  test('failed registration (duplicate username) does NOT consume quota', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');
    const ip = uniqueIp();
    const existingUser = uniqueUser();

    // Register once to create the user
    const first = await apiRegister(page, existingUser, 'password123', ip);
    expect(first.status()).toBe(201);

    // Try to register same username twice (duplicate, returns 409)
    const dup1 = await apiRegister(page, existingUser, 'password456', ip);
    expect(dup1.status()).toBe(409);
    const dup2 = await apiRegister(page, existingUser, 'password789', ip);
    expect(dup2.status()).toBe(409);

    // Two more successful registrations should still work (quota: 3 total, only 1 success so far)
    const ok2 = await apiRegister(page, uniqueUser(), 'password123', ip);
    expect(ok2.status()).toBe(201);
    const ok3 = await apiRegister(page, uniqueUser(), 'password123', ip);
    expect(ok3.status()).toBe(201);

    // Now quota is full (3 successes) -- 4th should be blocked
    const blocked = await apiRegister(page, uniqueUser(), 'password123', ip);
    expect(blocked.status()).toBe(429);
  });

  test('rate-limited response has CORS headers', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');
    const ip = uniqueIp();

    for (let i = 0; i < 3; i++) {
      await apiRegister(page, uniqueUser(), 'password123', ip);
    }
    const resp = await apiRegister(page, uniqueUser(), 'password123', ip);
    expect(resp.status()).toBe(429);
    expect(resp.headers()['access-control-allow-origin']).toBeTruthy();
  });
});

// =============================================================================
// LOGIN RATE LIMITING
// =============================================================================

test.describe('Login rate limiting', () => {
  test('5 failed attempts blocks the 6th', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');
    const ip = uniqueIp();

    // 5 failed login attempts (unknown user)
    for (let i = 0; i < 5; i++) {
      const resp = await page.request.post('/api/login', {
        data: { username: 'nonexistent_user_xyzzy', password: 'wrongpass' },
        headers: { 'x-forwarded-for': ip },
      });
      expect(resp.status()).toBe(401);
    }

    // 6th attempt should be rate limited
    const resp6 = await page.request.post('/api/login', {
      data: { username: 'nonexistent_user_xyzzy', password: 'wrongpass' },
      headers: { 'x-forwarded-for': ip },
    });
    expect(resp6.status()).toBe(429);
    const body = await resp6.json();
    expect(body.error).toBe('Too many requests');
    expect(resp6.headers()['retry-after']).toBeTruthy();
  });

  test('successful login does not increment failure counter', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');
    const ip = uniqueIp();
    const user = uniqueUser();

    // Register user
    const regResp = await page.request.post('/api/register', {
      data: { username: user, password: 'correctpass' },
      headers: { 'x-forwarded-for': uniqueIp() }, // different IP for registration
    });
    expect(regResp.status()).toBe(201);

    // 4 failed attempts
    for (let i = 0; i < 4; i++) {
      const resp = await page.request.post('/api/login', {
        data: { username: user, password: 'wrongpass' },
        headers: { 'x-forwarded-for': ip },
      });
      expect(resp.status()).toBe(401);
    }

    // Successful login (does NOT count as failure)
    const goodLogin = await page.request.post('/api/login', {
      data: { username: user, password: 'correctpass' },
      headers: { 'x-forwarded-for': ip },
    });
    expect(goodLogin.status()).toBe(200);

    // One more failure -- should still work (only 4 failures recorded, limit is 5)
    const failResp = await page.request.post('/api/login', {
      data: { username: user, password: 'wrongpass' },
      headers: { 'x-forwarded-for': ip },
    });
    expect(failResp.status()).toBe(401); // Not yet rate limited

    // 6th failure is blocked
    const blocked = await page.request.post('/api/login', {
      data: { username: user, password: 'wrongpass' },
      headers: { 'x-forwarded-for': ip },
    });
    expect(blocked.status()).toBe(429);
  });

  test('failed login with nonexistent username increments counter', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');
    const ip = uniqueIp();

    for (let i = 0; i < 5; i++) {
      await page.request.post('/api/login', {
        data: { username: `nosuchuser_${i}`, password: 'pass' },
        headers: { 'x-forwarded-for': ip },
      });
    }

    const resp = await page.request.post('/api/login', {
      data: { username: 'nosuchuser_final', password: 'pass' },
      headers: { 'x-forwarded-for': ip },
    });
    expect(resp.status()).toBe(429);
  });

  test('login rate limit is per-IP: different IPs are independent', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');
    const ip1 = uniqueIp();
    const ip2 = uniqueIp();

    // Exhaust ip1
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

    // ip2 is unaffected
    const allowedResp = await page.request.post('/api/login', {
      data: { username: 'nope', password: 'nope' },
      headers: { 'x-forwarded-for': ip2 },
    });
    expect(allowedResp.status()).toBe(401); // 401, not 429
  });
});
