/**
 * Adversarial tests for rate limiting on /api/login and /api/register.
 *
 * Each test uses a unique fake IP via CF-Connecting-IP to prevent cross-test
 * contamination with the shared D1 database. Tests do NOT navigate to the
 * page — pure API calls only.
 *
 * Rate limit constants from the implementation:
 *   LOGIN:    5 failed attempts per 15 minutes
 *   REGISTER: 3 attempts per 1 hour
 */

import { test, expect } from '@playwright/test';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Generate a unique fake IP per test to avoid cross-test contamination
 * with the shared D1 rate_limits table.
 */
function uniqueIp(): string {
  const a = Math.floor(Math.random() * 200) + 10;
  const b = Math.floor(Math.random() * 255);
  const c = Date.now() % 255; // time-derived to reduce collision chance
  const d = Math.floor(Math.random() * 255);
  return `${a}.${b}.${c}.${d}`;
}

function uniqueUser(): string {
  const timestamp = Date.now().toString(36).slice(-4);
  const random = Math.random().toString(36).slice(2, 6);
  return `u${timestamp}${random}`;
}

const BASE_URL = 'http://localhost:8788';

/**
 * Register a user via API. Returns the token.
 */
async function apiRegister(
  request: import('@playwright/test').APIRequestContext,
  username: string,
  password: string,
  ip: string,
): Promise<{ token: string; username: string }> {
  const resp = await request.post(`${BASE_URL}/api/register`, {
    headers: { 'CF-Connecting-IP': ip },
    data: { username, password },
  });
  if (!resp.ok()) {
    const body = await resp.json().catch(() => ({}));
    throw new Error(`Register failed (${resp.status()}): ${JSON.stringify(body)}`);
  }
  return resp.json();
}

// =============================================================================
// LOGIN RATE LIMIT BASICS
// =============================================================================

test.describe('Login rate limit basics', () => {
  test('5 failed logins → 6th attempt returns 429', async ({ request }) => {
    const ip = uniqueIp();

    // Make 5 failed login attempts with wrong password
    for (let i = 0; i < 5; i++) {
      const resp = await request.post(`${BASE_URL}/api/login`, {
        headers: { 'CF-Connecting-IP': ip },
        data: { username: 'nonexistentuser_rl1', password: 'wrongpassword' },
      });
      expect(resp.status()).toBe(401); // all 5 should fail normally
    }

    // 6th attempt must be rate limited
    const blocked = await request.post(`${BASE_URL}/api/login`, {
      headers: { 'CF-Connecting-IP': ip },
      data: { username: 'nonexistentuser_rl1', password: 'wrongpassword' },
    });
    expect(blocked.status()).toBe(429);
  });

  test('5th failed login still returns 401, not 429', async ({ request }) => {
    const ip = uniqueIp();

    for (let i = 0; i < 4; i++) {
      await request.post(`${BASE_URL}/api/login`, {
        headers: { 'CF-Connecting-IP': ip },
        data: { username: 'nonexistentuser_rl2', password: 'wrongpassword' },
      });
    }

    // The 5th failure should still be 401, not yet rate limited
    const fifth = await request.post(`${BASE_URL}/api/login`, {
      headers: { 'CF-Connecting-IP': ip },
      data: { username: 'nonexistentuser_rl2', password: 'wrongpassword' },
    });
    expect(fifth.status()).toBe(401);
  });

  test('429 response has Retry-After header that is a positive integer', async ({ request }) => {
    const ip = uniqueIp();

    for (let i = 0; i < 5; i++) {
      await request.post(`${BASE_URL}/api/login`, {
        headers: { 'CF-Connecting-IP': ip },
        data: { username: 'nonexistentuser_rl3', password: 'wrongpassword' },
      });
    }

    const blocked = await request.post(`${BASE_URL}/api/login`, {
      headers: { 'CF-Connecting-IP': ip },
      data: { username: 'nonexistentuser_rl3', password: 'wrongpassword' },
    });
    expect(blocked.status()).toBe(429);

    const retryAfterHeader = blocked.headers()['retry-after'];
    expect(retryAfterHeader).toBeTruthy();

    const retryAfterValue = parseInt(retryAfterHeader, 10);
    expect(Number.isInteger(retryAfterValue)).toBe(true);
    // Must be a strictly positive value — 0 is not a valid Retry-After
    expect(retryAfterValue).toBeGreaterThan(0);
    // Should be at most 15 minutes (the window)
    expect(retryAfterValue).toBeLessThanOrEqual(15 * 60);
  });

  test('429 response body is { "error": "Too many requests" }', async ({ request }) => {
    const ip = uniqueIp();

    for (let i = 0; i < 5; i++) {
      await request.post(`${BASE_URL}/api/login`, {
        headers: { 'CF-Connecting-IP': ip },
        data: { username: 'nonexistentuser_rl4', password: 'wrongpassword' },
      });
    }

    const blocked = await request.post(`${BASE_URL}/api/login`, {
      headers: { 'CF-Connecting-IP': ip },
      data: { username: 'nonexistentuser_rl4', password: 'wrongpassword' },
    });
    expect(blocked.status()).toBe(429);

    const body = await blocked.json();
    expect(body).toHaveProperty('error');
    expect(body.error).toBe('Too many requests');
  });

  test('successful login does not count toward failure limit', async ({ request }) => {
    const ip = uniqueIp();
    const username = uniqueUser();
    const password = 'validpass123';

    // Register user — use a different IP so register limit doesn't interfere
    const regIp = uniqueIp();
    await apiRegister(request, username, password, regIp);

    // 4 failed login attempts
    for (let i = 0; i < 4; i++) {
      const resp = await request.post(`${BASE_URL}/api/login`, {
        headers: { 'CF-Connecting-IP': ip },
        data: { username, password: 'wrongpassword' },
      });
      expect(resp.status()).toBe(401);
    }

    // 1 successful login — must succeed (4 failures < 5 limit)
    const success = await request.post(`${BASE_URL}/api/login`, {
      headers: { 'CF-Connecting-IP': ip },
      data: { username, password },
    });
    expect(success.status()).toBe(200);

    // After the success, 1 more failure should still be allowed (count is still 4)
    const afterSuccess = await request.post(`${BASE_URL}/api/login`, {
      headers: { 'CF-Connecting-IP': ip },
      data: { username, password: 'wrongpassword' },
    });
    // The successful login did not increment the failure counter, so this is
    // failure #5 — should be 401 not 429
    expect(afterSuccess.status()).toBe(401);

    // Now one more failure (#6 attempt from IP perspective but only 5 failures recorded)
    // This one should trigger the limit
    const shouldBeBlocked = await request.post(`${BASE_URL}/api/login`, {
      headers: { 'CF-Connecting-IP': ip },
      data: { username, password: 'wrongpassword' },
    });
    expect(shouldBeBlocked.status()).toBe(429);
  });

  test('after 5 failures, correct credentials are also blocked (pre-auth check)', async ({ request }) => {
    const ip = uniqueIp();
    const username = uniqueUser();
    const password = 'validpass123';

    const regIp = uniqueIp();
    await apiRegister(request, username, password, regIp);

    // 5 failed login attempts
    for (let i = 0; i < 5; i++) {
      await request.post(`${BASE_URL}/api/login`, {
        headers: { 'CF-Connecting-IP': ip },
        data: { username, password: 'wrongpassword' },
      });
    }

    // Even correct credentials should now be blocked
    const blocked = await request.post(`${BASE_URL}/api/login`, {
      headers: { 'CF-Connecting-IP': ip },
      data: { username, password }, // correct password
    });
    expect(blocked.status()).toBe(429);
    const body = await blocked.json();
    expect(body.error).toBe('Too many requests');
  });

  test('rate limit persists across multiple blocked requests', async ({ request }) => {
    const ip = uniqueIp();

    // Exhaust the limit
    for (let i = 0; i < 5; i++) {
      await request.post(`${BASE_URL}/api/login`, {
        headers: { 'CF-Connecting-IP': ip },
        data: { username: 'ghost', password: 'wrong' },
      });
    }

    // Multiple blocked attempts should all return 429
    for (let i = 0; i < 3; i++) {
      const resp = await request.post(`${BASE_URL}/api/login`, {
        headers: { 'CF-Connecting-IP': ip },
        data: { username: 'ghost', password: 'wrong' },
      });
      expect(resp.status()).toBe(429);
    }
  });
});

// =============================================================================
// REGISTRATION RATE LIMIT BASICS
// =============================================================================

test.describe('Registration rate limit basics', () => {
  test('3 registration attempts from same IP → 4th attempt returns 429', async ({ request }) => {
    const ip = uniqueIp();

    // 3 registration attempts (even failed ones count)
    for (let i = 0; i < 3; i++) {
      await request.post(`${BASE_URL}/api/register`, {
        headers: { 'CF-Connecting-IP': ip },
        data: { username: uniqueUser(), password: 'validpass123' },
      });
    }

    // 4th attempt must be rate limited
    const blocked = await request.post(`${BASE_URL}/api/register`, {
      headers: { 'CF-Connecting-IP': ip },
      data: { username: uniqueUser(), password: 'validpass123' },
    });
    expect(blocked.status()).toBe(429);
  });

  test('3rd registration attempt is allowed, not blocked', async ({ request }) => {
    const ip = uniqueIp();

    for (let i = 0; i < 2; i++) {
      await request.post(`${BASE_URL}/api/register`, {
        headers: { 'CF-Connecting-IP': ip },
        data: { username: uniqueUser(), password: 'validpass123' },
      });
    }

    // The 3rd attempt must succeed (within limit)
    const third = await request.post(`${BASE_URL}/api/register`, {
      headers: { 'CF-Connecting-IP': ip },
      data: { username: uniqueUser(), password: 'validpass123' },
    });
    // 201 = success, 409 = username conflict (also fine — not rate limited)
    expect([201, 409]).toContain(third.status());
    expect(third.status()).not.toBe(429);
  });

  test('register 429 has Retry-After header that is a positive integer', async ({ request }) => {
    const ip = uniqueIp();

    for (let i = 0; i < 3; i++) {
      await request.post(`${BASE_URL}/api/register`, {
        headers: { 'CF-Connecting-IP': ip },
        data: { username: uniqueUser(), password: 'validpass123' },
      });
    }

    const blocked = await request.post(`${BASE_URL}/api/register`, {
      headers: { 'CF-Connecting-IP': ip },
      data: { username: uniqueUser(), password: 'validpass123' },
    });
    expect(blocked.status()).toBe(429);

    const retryAfterHeader = blocked.headers()['retry-after'];
    expect(retryAfterHeader).toBeTruthy();

    const retryAfterValue = parseInt(retryAfterHeader, 10);
    expect(Number.isInteger(retryAfterValue)).toBe(true);
    // Must be strictly positive — 0 means "retry immediately" which defeats the purpose
    expect(retryAfterValue).toBeGreaterThan(0);
    // Should be at most 1 hour (the register window)
    expect(retryAfterValue).toBeLessThanOrEqual(60 * 60);
  });

  test('register 429 body is { "error": "Too many requests" }', async ({ request }) => {
    const ip = uniqueIp();

    for (let i = 0; i < 3; i++) {
      await request.post(`${BASE_URL}/api/register`, {
        headers: { 'CF-Connecting-IP': ip },
        data: { username: uniqueUser(), password: 'validpass123' },
      });
    }

    const blocked = await request.post(`${BASE_URL}/api/register`, {
      headers: { 'CF-Connecting-IP': ip },
      data: { username: uniqueUser(), password: 'validpass123' },
    });
    expect(blocked.status()).toBe(429);

    const body = await blocked.json();
    expect(body).toHaveProperty('error');
    expect(body.error).toBe('Too many requests');
  });

  test('failed registrations (bad input) still count toward the register rate limit', async ({ request }) => {
    const ip = uniqueIp();

    // Send 3 requests with invalid body — rate limit increments BEFORE validation
    for (let i = 0; i < 3; i++) {
      const resp = await request.post(`${BASE_URL}/api/register`, {
        headers: { 'CF-Connecting-IP': ip },
        data: { username: 'ab', password: 'x' }, // invalid: username too short, password too short
      });
      expect(resp.status()).toBe(400);
    }

    // 4th request — rate limit should trigger even with invalid data
    const blocked = await request.post(`${BASE_URL}/api/register`, {
      headers: { 'CF-Connecting-IP': ip },
      data: { username: uniqueUser(), password: 'validpass123' },
    });
    expect(blocked.status()).toBe(429);
  });

  test('duplicate username registration counts toward rate limit', async ({ request }) => {
    const ip = uniqueIp();
    const username = uniqueUser();

    // First registration succeeds
    const first = await request.post(`${BASE_URL}/api/register`, {
      headers: { 'CF-Connecting-IP': ip },
      data: { username, password: 'validpass123' },
    });
    expect(first.status()).toBe(201);

    // Second and third — same username → 409, but still counted
    for (let i = 0; i < 2; i++) {
      const resp = await request.post(`${BASE_URL}/api/register`, {
        headers: { 'CF-Connecting-IP': ip },
        data: { username, password: 'validpass123' },
      });
      expect(resp.status()).toBe(409);
    }

    // 4th attempt must be rate limited
    const blocked = await request.post(`${BASE_URL}/api/register`, {
      headers: { 'CF-Connecting-IP': ip },
      data: { username: uniqueUser(), password: 'validpass123' },
    });
    expect(blocked.status()).toBe(429);
  });
});

// =============================================================================
// IP ISOLATION
// =============================================================================

test.describe('IP isolation', () => {
  test('different IPs have independent login rate limits', async ({ request }) => {
    const ip1 = uniqueIp();
    const ip2 = uniqueIp();

    // Exhaust ip1's login limit
    for (let i = 0; i < 5; i++) {
      await request.post(`${BASE_URL}/api/login`, {
        headers: { 'CF-Connecting-IP': ip1 },
        data: { username: 'ghost', password: 'wrong' },
      });
    }

    // ip1 is blocked
    const blocked = await request.post(`${BASE_URL}/api/login`, {
      headers: { 'CF-Connecting-IP': ip1 },
      data: { username: 'ghost', password: 'wrong' },
    });
    expect(blocked.status()).toBe(429);

    // ip2 should NOT be blocked
    const ip2Resp = await request.post(`${BASE_URL}/api/login`, {
      headers: { 'CF-Connecting-IP': ip2 },
      data: { username: 'ghost', password: 'wrong' },
    });
    expect(ip2Resp.status()).toBe(401); // 401 = not found, not rate limited
    expect(ip2Resp.status()).not.toBe(429);
  });

  test('different IPs have independent register rate limits', async ({ request }) => {
    const ip1 = uniqueIp();
    const ip2 = uniqueIp();

    // Exhaust ip1's register limit
    for (let i = 0; i < 3; i++) {
      await request.post(`${BASE_URL}/api/register`, {
        headers: { 'CF-Connecting-IP': ip1 },
        data: { username: uniqueUser(), password: 'validpass123' },
      });
    }

    // ip1 is blocked
    const blocked = await request.post(`${BASE_URL}/api/register`, {
      headers: { 'CF-Connecting-IP': ip1 },
      data: { username: uniqueUser(), password: 'validpass123' },
    });
    expect(blocked.status()).toBe(429);

    // ip2 should still be able to register
    const ip2Resp = await request.post(`${BASE_URL}/api/register`, {
      headers: { 'CF-Connecting-IP': ip2 },
      data: { username: uniqueUser(), password: 'validpass123' },
    });
    expect(ip2Resp.status()).toBe(201);
    expect(ip2Resp.status()).not.toBe(429);
  });

  test('login and register rate limits are separate keys (different endpoints)', async ({ request }) => {
    const ip = uniqueIp();

    // Exhaust the login rate limit (5 failures)
    for (let i = 0; i < 5; i++) {
      await request.post(`${BASE_URL}/api/login`, {
        headers: { 'CF-Connecting-IP': ip },
        data: { username: 'ghost', password: 'wrong' },
      });
    }

    // Login is blocked
    const loginBlocked = await request.post(`${BASE_URL}/api/login`, {
      headers: { 'CF-Connecting-IP': ip },
      data: { username: 'ghost', password: 'wrong' },
    });
    expect(loginBlocked.status()).toBe(429);

    // Register should NOT be blocked — different rate limit key
    const registerResp = await request.post(`${BASE_URL}/api/register`, {
      headers: { 'CF-Connecting-IP': ip },
      data: { username: uniqueUser(), password: 'validpass123' },
    });
    expect(registerResp.status()).not.toBe(429);
    expect([201, 409]).toContain(registerResp.status());
  });
});

// =============================================================================
// X-FORWARDED-FOR FALLBACK
// =============================================================================

test.describe('X-Forwarded-For header fallback', () => {
  test('X-Forwarded-For is used when CF-Connecting-IP is absent', async ({ request }) => {
    const forwardedIp = uniqueIp();

    // 5 failed login attempts using X-Forwarded-For header only
    for (let i = 0; i < 5; i++) {
      await request.post(`${BASE_URL}/api/login`, {
        headers: { 'X-Forwarded-For': forwardedIp },
        data: { username: 'ghost', password: 'wrong' },
      });
    }

    // 6th should be rate limited
    const blocked = await request.post(`${BASE_URL}/api/login`, {
      headers: { 'X-Forwarded-For': forwardedIp },
      data: { username: 'ghost', password: 'wrong' },
    });
    expect(blocked.status()).toBe(429);
  });

  test('CF-Connecting-IP takes precedence over X-Forwarded-For', async ({ request }) => {
    const cfIp = uniqueIp();
    const forwardedIp = uniqueIp();

    // Exhaust the rate limit for forwardedIp (only via X-Forwarded-For)
    for (let i = 0; i < 5; i++) {
      await request.post(`${BASE_URL}/api/login`, {
        headers: { 'X-Forwarded-For': forwardedIp },
        data: { username: 'ghost', password: 'wrong' },
      });
    }

    // Now send a request with CF-Connecting-IP = cfIp but XFF = forwardedIp (exhausted)
    // CF-Connecting-IP takes precedence, so cfIp's bucket is used — should NOT be blocked
    const resp = await request.post(`${BASE_URL}/api/login`, {
      headers: {
        'CF-Connecting-IP': cfIp,
        'X-Forwarded-For': forwardedIp,
      },
      data: { username: 'ghost', password: 'wrong' },
    });
    // Should use cfIp (fresh), which is at 0 failures → 401 not 429
    expect(resp.status()).toBe(401);
    expect(resp.status()).not.toBe(429);
  });

  test('X-Forwarded-For with multiple IPs uses only the first one', async ({ request }) => {
    const firstIp = uniqueIp();
    const secondIp = uniqueIp();

    // Exhaust limit using first IP as the XFF value (single IP format)
    for (let i = 0; i < 5; i++) {
      await request.post(`${BASE_URL}/api/login`, {
        headers: { 'X-Forwarded-For': firstIp },
        data: { username: 'ghost', password: 'wrong' },
      });
    }

    // Now send with firstIp, secondIp in XFF — firstIp is exhausted
    const resp = await request.post(`${BASE_URL}/api/login`, {
      headers: { 'X-Forwarded-For': `${firstIp}, ${secondIp}` },
      data: { username: 'ghost', password: 'wrong' },
    });
    // First IP is exhausted → should be rate limited
    expect(resp.status()).toBe(429);
  });
});

// =============================================================================
// RATE LIMIT RESPONSE STRUCTURE
// =============================================================================

test.describe('Rate limit response structure', () => {
  test('login 429 includes Content-Type application/json', async ({ request }) => {
    const ip = uniqueIp();

    for (let i = 0; i < 5; i++) {
      await request.post(`${BASE_URL}/api/login`, {
        headers: { 'CF-Connecting-IP': ip },
        data: { username: 'ghost', password: 'wrong' },
      });
    }

    const blocked = await request.post(`${BASE_URL}/api/login`, {
      headers: { 'CF-Connecting-IP': ip },
      data: { username: 'ghost', password: 'wrong' },
    });
    expect(blocked.status()).toBe(429);

    const contentType = blocked.headers()['content-type'];
    expect(contentType).toContain('application/json');
  });

  test('register 429 includes Content-Type application/json', async ({ request }) => {
    const ip = uniqueIp();

    for (let i = 0; i < 3; i++) {
      await request.post(`${BASE_URL}/api/register`, {
        headers: { 'CF-Connecting-IP': ip },
        data: { username: uniqueUser(), password: 'validpass123' },
      });
    }

    const blocked = await request.post(`${BASE_URL}/api/register`, {
      headers: { 'CF-Connecting-IP': ip },
      data: { username: uniqueUser(), password: 'validpass123' },
    });
    expect(blocked.status()).toBe(429);

    const contentType = blocked.headers()['content-type'];
    expect(contentType).toContain('application/json');
  });

  test('login 429 includes CORS header', async ({ request }) => {
    const ip = uniqueIp();

    for (let i = 0; i < 5; i++) {
      await request.post(`${BASE_URL}/api/login`, {
        headers: { 'CF-Connecting-IP': ip },
        data: { username: 'ghost', password: 'wrong' },
      });
    }

    const blocked = await request.post(`${BASE_URL}/api/login`, {
      headers: { 'CF-Connecting-IP': ip },
      data: { username: 'ghost', password: 'wrong' },
    });
    expect(blocked.status()).toBe(429);

    const headers = blocked.headers();
    expect(headers['access-control-allow-origin']).toBeTruthy();
  });

  test('Retry-After header is a decimal integer string, not a float', async ({ request }) => {
    const ip = uniqueIp();

    for (let i = 0; i < 5; i++) {
      await request.post(`${BASE_URL}/api/login`, {
        headers: { 'CF-Connecting-IP': ip },
        data: { username: 'ghost', password: 'wrong' },
      });
    }

    const blocked = await request.post(`${BASE_URL}/api/login`, {
      headers: { 'CF-Connecting-IP': ip },
      data: { username: 'ghost', password: 'wrong' },
    });

    const retryAfterHeader = blocked.headers()['retry-after'];
    expect(retryAfterHeader).toBeTruthy();
    // Must be a whole number string (no decimal point)
    expect(retryAfterHeader).toMatch(/^\d+$/);
  });
});

// =============================================================================
// SUCCESSFUL LOGIN DOES NOT COUNT AS FAILURE
// =============================================================================

test.describe('Successful logins do not count toward failure limit', () => {
  test('4 failures + 1 success + 1 failure = still allowed (only 5 total failures triggers block)', async ({ request }) => {
    const ip = uniqueIp();
    const username = uniqueUser();
    const password = 'validpass123';

    const regIp = uniqueIp();
    await apiRegister(request, username, password, regIp);

    // 4 failed login attempts
    for (let i = 0; i < 4; i++) {
      const resp = await request.post(`${BASE_URL}/api/login`, {
        headers: { 'CF-Connecting-IP': ip },
        data: { username, password: 'wrongpassword' },
      });
      expect(resp.status()).toBe(401);
    }

    // 1 successful login — must NOT trigger 429 and must NOT increment failure counter
    const success = await request.post(`${BASE_URL}/api/login`, {
      headers: { 'CF-Connecting-IP': ip },
      data: { username, password },
    });
    expect(success.status()).toBe(200);
    const successBody = await success.json();
    expect(successBody).toHaveProperty('token');

    // 1 more failure — total failures is still 4, so this should be the 5th failure (allowed)
    const fifthFail = await request.post(`${BASE_URL}/api/login`, {
      headers: { 'CF-Connecting-IP': ip },
      data: { username, password: 'wrongpassword' },
    });
    expect(fifthFail.status()).toBe(401);

    // Now the 6th failure — total failures is 5, must be blocked
    const shouldBeBlocked = await request.post(`${BASE_URL}/api/login`, {
      headers: { 'CF-Connecting-IP': ip },
      data: { username, password: 'wrongpassword' },
    });
    expect(shouldBeBlocked.status()).toBe(429);
  });

  test('10 successful logins do not exhaust the failure rate limit', async ({ request }) => {
    const ip = uniqueIp();
    const username = uniqueUser();
    const password = 'validpass123';

    const regIp = uniqueIp();
    await apiRegister(request, username, password, regIp);

    // 10 successful logins
    for (let i = 0; i < 10; i++) {
      const resp = await request.post(`${BASE_URL}/api/login`, {
        headers: { 'CF-Connecting-IP': ip },
        data: { username, password },
      });
      expect(resp.status()).toBe(200);
    }

    // 5 failures should still be allowed (not rate limited)
    for (let i = 0; i < 5; i++) {
      const resp = await request.post(`${BASE_URL}/api/login`, {
        headers: { 'CF-Connecting-IP': ip },
        data: { username, password: 'wrongpassword' },
      });
      expect(resp.status()).toBe(401); // not 429
    }

    // Now the 6th failure should trigger the block
    const blocked = await request.post(`${BASE_URL}/api/login`, {
      headers: { 'CF-Connecting-IP': ip },
      data: { username, password: 'wrongpassword' },
    });
    expect(blocked.status()).toBe(429);
  });
});

// =============================================================================
// EDGE CASES AND ATTACK VECTORS
// =============================================================================

test.describe('Edge cases and attack vectors', () => {
  test('login with bad JSON body does not count toward rate limit', async ({ request }) => {
    const ip = uniqueIp();

    // Malformed JSON should return 400 without hitting the rate limit check
    // (the body is parsed before the rate limit check in handleLogin)
    for (let i = 0; i < 10; i++) {
      const resp = await request.post(`${BASE_URL}/api/login`, {
        headers: {
          'CF-Connecting-IP': ip,
          'Content-Type': 'application/json',
        },
        data: 'not valid json',
      });
      expect(resp.status()).toBe(400);
    }

    // Should still be able to make login attempts (not rate limited)
    const normalAttempt = await request.post(`${BASE_URL}/api/login`, {
      headers: { 'CF-Connecting-IP': ip },
      data: { username: 'ghost', password: 'wrong' },
    });
    expect(normalAttempt.status()).toBe(401); // not 429
  });

  test('login with missing credentials does not count toward rate limit', async ({ request }) => {
    const ip = uniqueIp();

    // Missing username/password → 400, should not count toward limit
    for (let i = 0; i < 10; i++) {
      const resp = await request.post(`${BASE_URL}/api/login`, {
        headers: { 'CF-Connecting-IP': ip },
        data: { username: '', password: '' },
      });
      expect(resp.status()).toBe(400);
    }

    // Should not be rate limited
    const normalAttempt = await request.post(`${BASE_URL}/api/login`, {
      headers: { 'CF-Connecting-IP': ip },
      data: { username: 'ghost', password: 'wrong' },
    });
    expect(normalAttempt.status()).toBe(401); // not 429
  });

  test('register with malformed JSON body counts toward register rate limit', async ({ request }) => {
    const ip = uniqueIp();

    // Rate limit is incremented BEFORE body parsing in handleRegister
    // So 3 malformed JSON requests consume the entire register quota
    for (let i = 0; i < 3; i++) {
      const resp = await request.post(`${BASE_URL}/api/register`, {
        headers: {
          'CF-Connecting-IP': ip,
          'Content-Type': 'application/json',
        },
        data: 'not valid json at all',
      });
      expect(resp.status()).toBe(400);
    }

    // 4th attempt should now be rate limited, even with valid data
    const blocked = await request.post(`${BASE_URL}/api/register`, {
      headers: { 'CF-Connecting-IP': ip },
      data: { username: uniqueUser(), password: 'validpass123' },
    });
    expect(blocked.status()).toBe(429);
  });

  test('no IP headers → rate limiting is skipped (fail-open for missing IP)', async ({ request }) => {
    // When neither CF-Connecting-IP nor X-Forwarded-For is present, the
    // implementation returns null for the IP and skips rate limiting entirely.
    // In production on Cloudflare, CF-Connecting-IP is always set, so this
    // code path only occurs in local dev. Fail-open prevents the shared
    // "unknown" bucket from contaminating all tests in local dev.

    // 10 failed login attempts with no IP header — none should be rate limited
    for (let i = 0; i < 10; i++) {
      const resp = await request.post(`${BASE_URL}/api/login`, {
        data: { username: 'doesnotexist_noip', password: 'wrongpassword' },
      });
      expect(resp.status()).toBe(401); // never 429 because IP is unknown
    }
  });

  test('very long IP string in CF-Connecting-IP is handled gracefully', async ({ request }) => {
    const longIp = 'a'.repeat(1000);

    const resp = await request.post(`${BASE_URL}/api/login`, {
      headers: { 'CF-Connecting-IP': longIp },
      data: { username: 'ghost', password: 'wrong' },
    });
    // Should return 401 (auth failure), not 500 (server error)
    expect([401, 429]).toContain(resp.status());
    expect(resp.status()).not.toBe(500);
  });

  test('special characters in CF-Connecting-IP header are handled gracefully', async ({ request }) => {
    const specialIp = "'; DROP TABLE rate_limits; --";

    const resp = await request.post(`${BASE_URL}/api/login`, {
      headers: { 'CF-Connecting-IP': specialIp },
      data: { username: 'ghost', password: 'wrong' },
    });
    // Should not cause a 500 error (SQL injection via rate limit key)
    expect([401, 429]).toContain(resp.status());
    expect(resp.status()).not.toBe(500);
  });

  test('subsequent requests after injection attempt still work', async ({ request }) => {
    // After the injection attempt above, the DB should still be functional
    const ip = uniqueIp();

    const resp = await request.post(`${BASE_URL}/api/login`, {
      headers: { 'CF-Connecting-IP': ip },
      data: { username: 'ghost', password: 'wrong' },
    });
    expect(resp.status()).toBe(401);
  });
});

// =============================================================================
// WINDOW BOUNDARY BEHAVIOR
// =============================================================================

test.describe('Window boundary behavior', () => {
  test('login rate limit window is approximately 15 minutes', async ({ request }) => {
    const ip = uniqueIp();

    // Exhaust the limit
    for (let i = 0; i < 5; i++) {
      await request.post(`${BASE_URL}/api/login`, {
        headers: { 'CF-Connecting-IP': ip },
        data: { username: 'ghost', password: 'wrong' },
      });
    }

    const blocked = await request.post(`${BASE_URL}/api/login`, {
      headers: { 'CF-Connecting-IP': ip },
      data: { username: 'ghost', password: 'wrong' },
    });
    expect(blocked.status()).toBe(429);

    const retryAfter = parseInt(blocked.headers()['retry-after'] ?? '0', 10);
    // Window is 15 * 60 = 900 seconds. Retry-After should be between 1 and 900.
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(900);
  });

  test('register rate limit window is approximately 1 hour', async ({ request }) => {
    const ip = uniqueIp();

    for (let i = 0; i < 3; i++) {
      await request.post(`${BASE_URL}/api/register`, {
        headers: { 'CF-Connecting-IP': ip },
        data: { username: uniqueUser(), password: 'validpass123' },
      });
    }

    const blocked = await request.post(`${BASE_URL}/api/register`, {
      headers: { 'CF-Connecting-IP': ip },
      data: { username: uniqueUser(), password: 'validpass123' },
    });
    expect(blocked.status()).toBe(429);

    const retryAfter = parseInt(blocked.headers()['retry-after'] ?? '0', 10);
    // Window is 60 * 60 = 3600 seconds. Retry-After should be between 1 and 3600.
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(3600);
  });
});

// =============================================================================
// CONCURRENT RATE LIMIT REQUESTS
// =============================================================================

test.describe('Concurrent rate limit behavior', () => {
  test('concurrent login failures from same IP all eventually trigger rate limit', async ({ request }) => {
    const ip = uniqueIp();

    // Fire 8 concurrent login failures — all from the same IP
    const responses = await Promise.all(
      Array.from({ length: 8 }, () =>
        request.post(`${BASE_URL}/api/login`, {
          headers: { 'CF-Connecting-IP': ip },
          data: { username: 'ghost', password: 'wrong' },
        }),
      ),
    );

    const statuses = await Promise.all(responses.map(r => r.status()));

    // Some should be 401 (before limit), some should be 429 (after limit)
    // Under concurrent access the exact split is non-deterministic,
    // but we must have at least some 429s and no 500s.
    const has429 = statuses.some(s => s === 429);
    const has500 = statuses.some(s => s === 500);

    expect(has500).toBe(false);
    // After 8 concurrent failures to the same IP with a limit of 5,
    // at least some must be 429.
    expect(has429).toBe(true);
  });

  test('concurrent register requests from same IP all return non-500 status', async ({ request }) => {
    const ip = uniqueIp();

    // Fire 6 concurrent register requests (limit is 3)
    const responses = await Promise.all(
      Array.from({ length: 6 }, () =>
        request.post(`${BASE_URL}/api/register`, {
          headers: { 'CF-Connecting-IP': ip },
          data: { username: uniqueUser(), password: 'validpass123' },
        }),
      ),
    );

    const statuses = await Promise.all(responses.map(r => r.status()));

    // No 500 errors under concurrent load
    statuses.forEach(status => {
      expect(status).not.toBe(500);
    });

    // Must see at least one 429 (limit is 3, we sent 6)
    const has429 = statuses.some(s => s === 429);
    expect(has429).toBe(true);
  });
});
