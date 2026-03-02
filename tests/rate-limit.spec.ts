import { test, expect } from '@playwright/test';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function uniqueUser(): string {
  const timestamp = Date.now().toString(36).slice(-4);
  const random = Math.random().toString(36).slice(2, 6);
  return `u${timestamp}${random}`;
}

/** Returns a unique IP for this test so rate limit state doesn't bleed. */
function uniqueTestIP(): string {
  const a = Math.floor(Math.random() * 254) + 1;
  const b = Math.floor(Math.random() * 254) + 1;
  const c = Math.floor(Math.random() * 254) + 1;
  return `10.${a}.${b}.${c}`;
}

// =============================================================================
// LOGIN RATE LIMITING
// 5 failed attempts per IP per 15 minutes
// =============================================================================

test.describe('Login rate limiting', () => {
  test('5 failed attempts from same IP then 6th is rate-limited (429)', async ({ page }) => {
    await page.goto('/');
    const ip = uniqueTestIP();

    // Make 5 failed login attempts
    for (let i = 0; i < 5; i++) {
      const resp = await page.request.post('/api/login', {
        headers: { 'X-Forwarded-For': ip },
        data: { username: 'nosuchuser', password: 'wrongpass' },
      });
      expect(resp.status()).toBe(401);
    }

    // 6th attempt should be rate-limited
    const resp6 = await page.request.post('/api/login', {
      headers: { 'X-Forwarded-For': ip },
      data: { username: 'nosuchuser', password: 'wrongpass' },
    });
    expect(resp6.status()).toBe(429);
  });

  test('rate limit response includes Retry-After header', async ({ page }) => {
    await page.goto('/');
    const ip = uniqueTestIP();

    // Exhaust the limit
    for (let i = 0; i < 5; i++) {
      await page.request.post('/api/login', {
        headers: { 'X-Forwarded-For': ip },
        data: { username: 'nosuchuser', password: 'wrongpass' },
      });
    }

    const resp = await page.request.post('/api/login', {
      headers: { 'X-Forwarded-For': ip },
      data: { username: 'nosuchuser', password: 'wrongpass' },
    });
    expect(resp.status()).toBe(429);
    const retryAfter = resp.headers()['retry-after'];
    expect(retryAfter).toBeTruthy();
    const seconds = parseInt(retryAfter, 10);
    expect(seconds).toBeGreaterThan(0);
    expect(seconds).toBeLessThanOrEqual(15 * 60);
  });

  test('rate limit error body contains error field', async ({ page }) => {
    await page.goto('/');
    const ip = uniqueTestIP();

    for (let i = 0; i < 5; i++) {
      await page.request.post('/api/login', {
        headers: { 'X-Forwarded-For': ip },
        data: { username: 'nosuchuser', password: 'wrongpass' },
      });
    }

    const resp = await page.request.post('/api/login', {
      headers: { 'X-Forwarded-For': ip },
      data: { username: 'nosuchuser', password: 'wrongpass' },
    });
    expect(resp.status()).toBe(429);
    const body = await resp.json();
    expect(body).toHaveProperty('error');
  });

  test('successful login does not increment rate limit counter', async ({ page }) => {
    await page.goto('/');
    const ip = uniqueTestIP();
    const user = uniqueUser();

    // Register user (using a different IP to avoid burning registration limit)
    const regResp = await page.request.post('/api/register', {
      headers: { 'X-Forwarded-For': uniqueTestIP() },
      data: { username: user, password: 'correctpass' },
    });
    expect(regResp.status()).toBe(201);

    // Make 4 failed attempts
    for (let i = 0; i < 4; i++) {
      const resp = await page.request.post('/api/login', {
        headers: { 'X-Forwarded-For': ip },
        data: { username: user, password: 'wrongpass' },
      });
      expect(resp.status()).toBe(401);
    }

    // Successful login
    const successResp = await page.request.post('/api/login', {
      headers: { 'X-Forwarded-For': ip },
      data: { username: user, password: 'correctpass' },
    });
    expect(successResp.status()).toBe(200);

    // 5th attempt after a success — should still be allowed (success didn't count)
    // We've used 4 slots; one more failure is allowed before hitting limit
    const resp5 = await page.request.post('/api/login', {
      headers: { 'X-Forwarded-For': ip },
      data: { username: user, password: 'wrongpass' },
    });
    expect(resp5.status()).toBe(401);

    // 6th attempt: now at limit (4 failures + 1 more = 5 total)
    const resp6 = await page.request.post('/api/login', {
      headers: { 'X-Forwarded-For': ip },
      data: { username: user, password: 'wrongpass' },
    });
    expect(resp6.status()).toBe(429);
  });

  test('rate limits are per-IP (different IPs have independent limits)', async ({ page }) => {
    await page.goto('/');
    const ip1 = uniqueTestIP();
    const ip2 = uniqueTestIP();

    // Exhaust limit for ip1
    for (let i = 0; i < 5; i++) {
      await page.request.post('/api/login', {
        headers: { 'X-Forwarded-For': ip1 },
        data: { username: 'nosuchuser', password: 'wrongpass' },
      });
    }
    const blockedResp = await page.request.post('/api/login', {
      headers: { 'X-Forwarded-For': ip1 },
      data: { username: 'nosuchuser', password: 'wrongpass' },
    });
    expect(blockedResp.status()).toBe(429);

    // ip2 should still be allowed
    const allowedResp = await page.request.post('/api/login', {
      headers: { 'X-Forwarded-For': ip2 },
      data: { username: 'nosuchuser', password: 'wrongpass' },
    });
    expect(allowedResp.status()).toBe(401); // 401, not 429
  });

  test('bad JSON body during rate-limited period still returns 429', async ({ page }) => {
    await page.goto('/');
    const ip = uniqueTestIP();

    for (let i = 0; i < 5; i++) {
      await page.request.post('/api/login', {
        headers: { 'X-Forwarded-For': ip },
        data: { username: 'nosuchuser', password: 'wrongpass' },
      });
    }

    // Rate check happens before body parse, so malformed body still gets 429
    const resp = await page.request.fetch('/api/login', {
      method: 'POST',
      headers: { 'X-Forwarded-For': ip, 'Content-Type': 'application/json' },
      data: 'not-json',
    });
    expect(resp.status()).toBe(429);
  });
});

// =============================================================================
// REGISTRATION RATE LIMITING
// 3 registration attempts per IP per hour
// =============================================================================

test.describe('Registration rate limiting', () => {
  test('3 registration attempts then 4th is rate-limited (429)', async ({ page }) => {
    await page.goto('/');
    const ip = uniqueTestIP();

    // 3 valid registration attempts (each with a unique username)
    for (let i = 0; i < 3; i++) {
      const user = uniqueUser();
      const resp = await page.request.post('/api/register', {
        headers: { 'X-Forwarded-For': ip },
        data: { username: user, password: 'password123' },
      });
      // Should be 201 (created) or 409 (conflict) — not 429
      expect([201, 409]).toContain(resp.status());
    }

    // 4th attempt should be rate-limited regardless of username validity
    const resp4 = await page.request.post('/api/register', {
      headers: { 'X-Forwarded-For': ip },
      data: { username: uniqueUser(), password: 'password123' },
    });
    expect(resp4.status()).toBe(429);
  });

  test('registration rate limit response includes Retry-After header', async ({ page }) => {
    await page.goto('/');
    const ip = uniqueTestIP();

    for (let i = 0; i < 3; i++) {
      await page.request.post('/api/register', {
        headers: { 'X-Forwarded-For': ip },
        data: { username: uniqueUser(), password: 'password123' },
      });
    }

    const resp = await page.request.post('/api/register', {
      headers: { 'X-Forwarded-For': ip },
      data: { username: uniqueUser(), password: 'password123' },
    });
    expect(resp.status()).toBe(429);
    const retryAfter = resp.headers()['retry-after'];
    expect(retryAfter).toBeTruthy();
    const seconds = parseInt(retryAfter, 10);
    expect(seconds).toBeGreaterThan(0);
    expect(seconds).toBeLessThanOrEqual(60 * 60);
  });

  test('validation errors (bad JSON) do not count toward registration limit', async ({ page }) => {
    await page.goto('/');
    const ip = uniqueTestIP();

    // Make 3 requests that fail validation (before rate limit check)
    for (let i = 0; i < 3; i++) {
      await page.request.fetch('/api/register', {
        method: 'POST',
        headers: { 'X-Forwarded-For': ip, 'Content-Type': 'application/json' },
        data: 'not-json',
      });
    }

    // Also make 3 requests that fail field validation (short username — 400 before rate check)
    for (let i = 0; i < 3; i++) {
      await page.request.post('/api/register', {
        headers: { 'X-Forwarded-For': ip },
        data: { username: 'ab', password: 'password123' }, // too short
      });
    }

    // Should still have 3 allowed registrations (validation errors don't count)
    const resp = await page.request.post('/api/register', {
      headers: { 'X-Forwarded-For': ip },
      data: { username: uniqueUser(), password: 'password123' },
    });
    expect([201, 409]).toContain(resp.status()); // not 429
  });

  test('registration limits are per-IP', async ({ page }) => {
    await page.goto('/');
    const ip1 = uniqueTestIP();
    const ip2 = uniqueTestIP();

    // Exhaust limit for ip1
    for (let i = 0; i < 3; i++) {
      await page.request.post('/api/register', {
        headers: { 'X-Forwarded-For': ip1 },
        data: { username: uniqueUser(), password: 'password123' },
      });
    }
    const blocked = await page.request.post('/api/register', {
      headers: { 'X-Forwarded-For': ip1 },
      data: { username: uniqueUser(), password: 'password123' },
    });
    expect(blocked.status()).toBe(429);

    // ip2 is unaffected
    const allowed = await page.request.post('/api/register', {
      headers: { 'X-Forwarded-For': ip2 },
      data: { username: uniqueUser(), password: 'password123' },
    });
    expect([201, 409]).toContain(allowed.status());
  });
});

// =============================================================================
// ACCOUNT DELETION RATE LIMITING
// 1 deletion per user per day
// =============================================================================

test.describe('Account deletion rate limiting', () => {
  test('second account deletion within 24h returns 429', async ({ page }) => {
    await page.goto('/');
    const user = uniqueUser();
    const ip = uniqueTestIP();

    const regResp = await page.request.post('/api/register', {
      headers: { 'X-Forwarded-For': ip },
      data: { username: user, password: 'password123' },
    });
    expect(regResp.status()).toBe(201);
    const { token } = await regResp.json();

    // First deletion succeeds
    const del1 = await page.request.delete('/api/account', {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: JSON.stringify({ password: 'password123' }),
    });
    expect(del1.status()).toBe(200);

    // Second deletion within 24h is rate-limited (user is deleted but rate limit entry persists)
    const del2 = await page.request.delete('/api/account', {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: JSON.stringify({ password: 'password123' }),
    });
    expect(del2.status()).toBe(429);
    const retryAfter = del2.headers()['retry-after'];
    expect(retryAfter).toBeTruthy();
  });

  test('deletion rate limit is per user ID, not per IP', async ({ page }) => {
    await page.goto('/');
    const ip1 = uniqueTestIP();
    const ip2 = uniqueTestIP();

    // Register two different users from different IPs
    const reg1 = await page.request.post('/api/register', {
      headers: { 'X-Forwarded-For': ip1 },
      data: { username: uniqueUser(), password: 'password123' },
    });
    expect(reg1.status()).toBe(201);
    const { token: token1 } = await reg1.json();

    const reg2 = await page.request.post('/api/register', {
      headers: { 'X-Forwarded-For': ip2 },
      data: { username: uniqueUser(), password: 'password123' },
    });
    expect(reg2.status()).toBe(201);
    const { token: token2 } = await reg2.json();

    // Delete user1
    const del1 = await page.request.delete('/api/account', {
      headers: { Authorization: `Bearer ${token1}`, 'Content-Type': 'application/json' },
      data: JSON.stringify({ password: 'password123' }),
    });
    expect(del1.status()).toBe(200);

    // User2 can still delete (different user ID, different rate limit key)
    const del2 = await page.request.delete('/api/account', {
      headers: { Authorization: `Bearer ${token2}`, 'Content-Type': 'application/json' },
      data: JSON.stringify({ password: 'password123' }),
    });
    expect(del2.status()).toBe(200);
  });
});
