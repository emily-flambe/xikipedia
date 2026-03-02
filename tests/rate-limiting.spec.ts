/**
 * Rate Limiting Tests — Adversarial
 *
 * Attack surface: login, register, and delete account endpoints all have
 * rate limits stored in the D1 rate_limits table.
 *
 * Key implementation facts from src/index.ts (branch orca/EMI-23-inv-563):
 *
 *   handleRegister:
 *     1. Parse JSON (fail → 400, no rate limit increment)
 *     2. Validate username/password (fail → 400, no rate limit increment)
 *     3. CHECK rate limit (count >= 3 for IP per 1hr) — BLOCKED = 429
 *     4. Insert into DB
 *     5. On success OR duplicate (409) OR DB error (500) → increment counter
 *     Rate limit key: register:<ip>
 *
 *   handleLogin:
 *     1. CHECK rate limit (count >= 5 for IP per 15min) — BLOCKED = 429
 *     2. Parse JSON (fail → 400, no increment)
 *     3. Validate types (fail → 400, no increment)
 *     4. User lookup — not found → increment + 401
 *     5. Password check — wrong → increment + 401
 *     6. Success → no increment
 *     Rate limit key: login:<ip>
 *
 *   handleDeleteAccount:
 *     1. Auth token verify (fail → 401, no increment)
 *     2. CHECK rate limit (count >= 1 for userId per 24hr) — BLOCKED = 429
 *     3. Parse JSON (fail → 400, no increment)
 *     4. Validate password field (fail → 400, no increment)
 *     5. User lookup — not found → 404, no increment
 *     6. Password check — wrong → 403, no increment
 *     7. Delete user → increment + 200
 *     Rate limit key: delete:<userId>
 *
 * Isolation strategy:
 *   Since all tests share the "unknown" IP in local wrangler dev
 *   (no CF-Connecting-IP header), every test that SETS UP users via register
 *   must send a unique X-Forwarded-For header so setup doesn't pollute the
 *   shared "unknown" IP register bucket. The apiRegisterWithIP helper does this.
 *
 *   Tests that specifically test rate limiting behavior use unique spoofed IPs
 *   per test to get isolated buckets.
 *
 *   Delete rate limiting is per-userId, so each test with a unique user is
 *   already isolated.
 */

import { test, expect, Page } from '@playwright/test';

// ---- Helpers ----------------------------------------------------------------

function uniqueUser(): string {
  // Username must be 3-20 chars, alphanumeric + underscores only
  const timestamp = Date.now().toString(36).slice(-4);
  const random = Math.random().toString(36).slice(2, 6);
  return `u${timestamp}${random}`;
}

/** Returns a unique IP so each test gets its own isolated rate limit bucket. */
function uniqueTestIP(): string {
  const a = Math.floor(Math.random() * 254) + 1;
  const b = Math.floor(Math.random() * 254) + 1;
  const c = Math.floor(Math.random() * 254) + 1;
  return `10.${a}.${b}.${c}`;
}

/**
 * Register a user with a unique IP for test isolation.
 * This prevents registration setup from consuming the shared "unknown" IP bucket.
 */
async function apiRegisterWithIP(
  page: Page,
  username: string,
  password: string,
  ip: string,
): Promise<{ token: string; username: string }> {
  const resp = await page.request.post('/api/register', {
    headers: { 'X-Forwarded-For': ip },
    data: { username, password },
  });
  if (!resp.ok()) {
    const body = await resp.json().catch(() => null);
    throw new Error(`Registration failed: ${resp.status()} ${JSON.stringify(body)}`);
  }
  return resp.json();
}

// =============================================================================
// LOGIN RATE LIMITING
// Rate limit key: login:<ip>
// Limit: 5 per IP per 15 minutes
// What increments: only failed logins (wrong user or wrong password)
// What does NOT increment: malformed JSON, missing/wrong-type fields, success
// =============================================================================

test.describe('Login rate limiting', () => {
  /**
   * Core happy path: 5 failures then 6th is blocked.
   * Verifies the limit is enforced at all.
   */
  test('5 failed logins → 6th is rate-limited (429)', async ({ page }) => {
    await page.goto('/');
    const ip = uniqueTestIP();

    for (let i = 0; i < 5; i++) {
      const resp = await page.request.post('/api/login', {
        headers: { 'X-Forwarded-For': ip },
        data: { username: 'nosuchuser', password: 'wrongpass' },
      });
      expect(resp.status()).toBe(401);
    }

    const resp6 = await page.request.post('/api/login', {
      headers: { 'X-Forwarded-For': ip },
      data: { username: 'nosuchuser', password: 'wrongpass' },
    });
    expect(resp6.status()).toBe(429);
  });

  /**
   * Successful logins must NOT increment the failure counter.
   * After 4 failures and 1 success, one more failure should be allowed
   * (still at 4/5). Two more failures will push to 5 then trigger limit.
   */
  test('successful login does not consume the failure counter', async ({ page }) => {
    await page.goto('/');
    const setupIP = uniqueTestIP();
    const testIP = uniqueTestIP();
    const user = uniqueUser();

    await apiRegisterWithIP(page, user, 'correctpass', setupIP);

    // 4 failures
    for (let i = 0; i < 4; i++) {
      const resp = await page.request.post('/api/login', {
        headers: { 'X-Forwarded-For': testIP },
        data: { username: user, password: 'wrongpass' },
      });
      expect(resp.status()).toBe(401);
    }

    // 1 success — must NOT count toward limit
    const successResp = await page.request.post('/api/login', {
      headers: { 'X-Forwarded-For': testIP },
      data: { username: user, password: 'correctpass' },
    });
    expect(successResp.status()).toBe(200);

    // 5th failure — still allowed (counter is at 4)
    const resp5 = await page.request.post('/api/login', {
      headers: { 'X-Forwarded-For': testIP },
      data: { username: user, password: 'wrongpass' },
    });
    expect(resp5.status()).toBe(401);

    // 6th failure — now blocked (counter hit 5 after the 5th failure)
    const resp6 = await page.request.post('/api/login', {
      headers: { 'X-Forwarded-For': testIP },
      data: { username: user, password: 'wrongpass' },
    });
    expect(resp6.status()).toBe(429);
  });

  /**
   * Malformed JSON does NOT increment the login counter.
   * The rate check runs BEFORE body parse, so bad JSON doesn't count —
   * it returns 400 (not a login failure, just a bad request).
   */
  test('malformed JSON body does not increment login failure counter', async ({ page }) => {
    await page.goto('/');
    const ip = uniqueTestIP();

    // 6 malformed requests — if each incremented, we'd get 429
    for (let i = 0; i < 6; i++) {
      const resp = await page.request.fetch('/api/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Forwarded-For': ip,
        },
        data: '{not valid json',
      });
      expect(resp.status()).toBe(400);
    }
  });

  /**
   * Missing/wrong-type username/password fields return 400 and do NOT increment
   * the failure counter.
   */
  test('login with missing username field does not increment failure counter', async ({ page }) => {
    await page.goto('/');
    const ip = uniqueTestIP();

    // 6 requests with missing username
    for (let i = 0; i < 6; i++) {
      const resp = await page.request.post('/api/login', {
        headers: { 'X-Forwarded-For': ip },
        data: { password: 'password123' }, // no username
      });
      expect(resp.status()).toBe(400);
    }
  });

  /**
   * 429 response body must be exactly { error: 'Too many requests' }.
   * The error key and value must match what the frontend expects.
   */
  test('429 response body is well-formed JSON with error: "Too many requests"', async ({ page }) => {
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

    const contentType = resp.headers()['content-type'];
    expect(contentType).toContain('application/json');

    const body = await resp.json();
    expect(body).toHaveProperty('error');
    expect(body.error).toBe('Too many requests');
  });

  /**
   * 429 response must include Retry-After header.
   * Value must be a positive integer in the range (0, 900] (15 minutes = 900s).
   */
  test('429 includes Retry-After header with valid positive integer <= 900', async ({ page }) => {
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

    const retryAfterHeader = resp.headers()['retry-after'];
    expect(retryAfterHeader).toBeTruthy();
    const retryAfter = parseInt(retryAfterHeader, 10);
    expect(isNaN(retryAfter)).toBe(false);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(900);
  });

  /**
   * 429 response must include CORS headers so the browser can read the error
   * body in a cross-origin context.
   */
  test('429 login response includes CORS headers', async ({ page }) => {
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

    const headers = resp.headers();
    expect(headers['access-control-allow-origin']).toBeTruthy();
  });

  /**
   * Rate limits are per-IP. Two different IPs have independent counters.
   */
  test('different IPs have independent login failure counters', async ({ page }) => {
    await page.goto('/');
    const ip1 = uniqueTestIP();
    const ip2 = uniqueTestIP();

    // Exhaust ip1
    for (let i = 0; i < 5; i++) {
      await page.request.post('/api/login', {
        headers: { 'X-Forwarded-For': ip1 },
        data: { username: 'nosuchuser', password: 'wrongpass' },
      });
    }

    // ip1 is blocked
    const blockedResp = await page.request.post('/api/login', {
      headers: { 'X-Forwarded-For': ip1 },
      data: { username: 'nosuchuser', password: 'wrongpass' },
    });
    expect(blockedResp.status()).toBe(429);

    // ip2 is NOT blocked — should get 401 (wrong credentials), not 429
    const allowedResp = await page.request.post('/api/login', {
      headers: { 'X-Forwarded-For': ip2 },
      data: { username: 'nosuchuser', password: 'wrongpass' },
    });
    expect(allowedResp.status()).toBe(401);
  });

  /**
   * Once rate-limited, even the correct password is blocked.
   * The rate limit check runs BEFORE credential verification.
   */
  test('correct password is blocked once rate limit is exhausted', async ({ page }) => {
    await page.goto('/');
    const setupIP = uniqueTestIP();
    const testIP = uniqueTestIP();
    const user = uniqueUser();

    await apiRegisterWithIP(page, user, 'correctpass', setupIP);

    // Exhaust the login counter with failures
    for (let i = 0; i < 5; i++) {
      await page.request.post('/api/login', {
        headers: { 'X-Forwarded-For': testIP },
        data: { username: user, password: 'WRONG' },
      });
    }

    // Even correct password gets 429 now
    const resp = await page.request.post('/api/login', {
      headers: { 'X-Forwarded-For': testIP },
      data: { username: user, password: 'correctpass' },
    });
    expect(resp.status()).toBe(429);
  });

  /**
   * Rate limit persists: multiple requests after exhaustion all return 429.
   */
  test('rate limit persists across multiple subsequent requests', async ({ page }) => {
    await page.goto('/');
    const ip = uniqueTestIP();

    for (let i = 0; i < 5; i++) {
      await page.request.post('/api/login', {
        headers: { 'X-Forwarded-For': ip },
        data: { username: 'nosuchuser', password: 'wrongpass' },
      });
    }

    for (let i = 0; i < 3; i++) {
      const resp = await page.request.post('/api/login', {
        headers: { 'X-Forwarded-For': ip },
        data: { username: 'nosuchuser', password: 'wrongpass' },
      });
      expect(resp.status()).toBe(429);
    }
  });

  /**
   * Once rate-limited, even malformed JSON returns 429 (rate check is first).
   */
  test('malformed JSON after rate limit exhaustion still returns 429', async ({ page }) => {
    await page.goto('/');
    const ip = uniqueTestIP();

    for (let i = 0; i < 5; i++) {
      await page.request.post('/api/login', {
        headers: { 'X-Forwarded-For': ip },
        data: { username: 'nosuchuser', password: 'wrongpass' },
      });
    }

    const resp = await page.request.fetch('/api/login', {
      method: 'POST',
      headers: { 'X-Forwarded-For': ip, 'Content-Type': 'application/json' },
      data: 'not-json',
    });
    expect(resp.status()).toBe(429);
  });

  /**
   * X-Forwarded-For with comma-separated chain uses the FIRST (leftmost) IP.
   * "client, proxy1, proxy2" → client IP is used.
   */
  test('X-Forwarded-For comma chain uses first IP for rate limit key', async ({ page }) => {
    await page.goto('/');
    const clientIP = uniqueTestIP();
    const proxyIP = uniqueTestIP();
    const multiValueHeader = `${clientIP}, ${proxyIP}`;

    // Exhaust using the multi-value header (first IP is clientIP)
    for (let i = 0; i < 5; i++) {
      await page.request.post('/api/login', {
        headers: { 'X-Forwarded-For': multiValueHeader },
        data: { username: 'nosuchuser', password: 'wrongpass' },
      });
    }

    // clientIP is blocked when using the chain header
    const blockedViaChain = await page.request.post('/api/login', {
      headers: { 'X-Forwarded-For': multiValueHeader },
      data: { username: 'nosuchuser', password: 'wrongpass' },
    });
    expect(blockedViaChain.status()).toBe(429);

    // Using just clientIP alone is also blocked (same bucket)
    const blockedViaClientOnly = await page.request.post('/api/login', {
      headers: { 'X-Forwarded-For': clientIP },
      data: { username: 'nosuchuser', password: 'wrongpass' },
    });
    expect(blockedViaClientOnly.status()).toBe(429);

    // proxyIP alone is NOT blocked (different bucket)
    const notBlockedViaProxy = await page.request.post('/api/login', {
      headers: { 'X-Forwarded-For': proxyIP },
      data: { username: 'nosuchuser', password: 'wrongpass' },
    });
    expect(notBlockedViaProxy.status()).toBe(401);
  });

  /**
   * Exactly 5 failures are allowed; 6th is blocked.
   * Off-by-one boundary check.
   */
  test('boundary: exactly 5 failures allowed, 6th blocked', async ({ page }) => {
    await page.goto('/');
    const ip = uniqueTestIP();

    for (let i = 1; i <= 5; i++) {
      const resp = await page.request.post('/api/login', {
        headers: { 'X-Forwarded-For': ip },
        data: { username: 'nosuchuser', password: 'wrongpass' },
      });
      expect(resp.status()).toBe(401);
    }

    const resp6 = await page.request.post('/api/login', {
      headers: { 'X-Forwarded-For': ip },
      data: { username: 'nosuchuser', password: 'wrongpass' },
    });
    expect(resp6.status()).toBe(429);
  });
});

// =============================================================================
// REGISTER RATE LIMITING
// Rate limit key: register:<ip>
// Limit: 3 per IP per 1 hour
// What increments: only valid registration attempts (pass JSON parse + validation)
// What does NOT increment: malformed JSON, validation failures
// Note: Rate check happens AFTER validation in actual implementation
// =============================================================================

test.describe('Registration rate limiting', () => {
  /**
   * Core: 3 valid attempts then 4th is blocked.
   */
  test('3 successful registrations then 4th is rate-limited (429)', async ({ page }) => {
    await page.goto('/');
    const ip = uniqueTestIP();

    for (let i = 0; i < 3; i++) {
      const resp = await page.request.post('/api/register', {
        headers: { 'X-Forwarded-For': ip },
        data: { username: uniqueUser(), password: 'password123' },
      });
      expect(resp.status()).toBe(201);
    }

    const resp4 = await page.request.post('/api/register', {
      headers: { 'X-Forwarded-For': ip },
      data: { username: uniqueUser(), password: 'password123' },
    });
    expect(resp4.status()).toBe(429);
  });

  /**
   * Boundary: exactly 3 registrations allowed, 4th blocked.
   * Third attempt must succeed (not be blocked at 3).
   */
  test('boundary: 3rd registration succeeds, 4th is blocked', async ({ page }) => {
    await page.goto('/');
    const ip = uniqueTestIP();

    const r1 = await page.request.post('/api/register', {
      headers: { 'X-Forwarded-For': ip },
      data: { username: uniqueUser(), password: 'password123' },
    });
    expect(r1.status()).toBe(201);

    const r2 = await page.request.post('/api/register', {
      headers: { 'X-Forwarded-For': ip },
      data: { username: uniqueUser(), password: 'password123' },
    });
    expect(r2.status()).toBe(201);

    const r3 = await page.request.post('/api/register', {
      headers: { 'X-Forwarded-For': ip },
      data: { username: uniqueUser(), password: 'password123' },
    });
    expect(r3.status()).toBe(201);

    const r4 = await page.request.post('/api/register', {
      headers: { 'X-Forwarded-For': ip },
      data: { username: uniqueUser(), password: 'password123' },
    });
    expect(r4.status()).toBe(429);
  });

  /**
   * Validation errors (malformed JSON, bad username) do NOT count toward the limit.
   * The rate check happens after validation, so failures before that point don't consume quota.
   */
  test('validation errors and malformed JSON do not count toward register limit', async ({ page }) => {
    await page.goto('/');
    const ip = uniqueTestIP();

    // 3 malformed JSON requests
    for (let i = 0; i < 3; i++) {
      await page.request.fetch('/api/register', {
        method: 'POST',
        headers: { 'X-Forwarded-For': ip, 'Content-Type': 'application/json' },
        data: 'not-json',
      });
    }

    // 3 validation failure requests (username too short)
    for (let i = 0; i < 3; i++) {
      await page.request.post('/api/register', {
        headers: { 'X-Forwarded-For': ip },
        data: { username: 'ab', password: 'password123' },
      });
    }

    // All 3 allowed registrations must still be available
    for (let i = 0; i < 3; i++) {
      const resp = await page.request.post('/api/register', {
        headers: { 'X-Forwarded-For': ip },
        data: { username: uniqueUser(), password: 'password123' },
      });
      expect(resp.status()).toBe(201);
    }

    // 4th valid request is blocked
    const resp4 = await page.request.post('/api/register', {
      headers: { 'X-Forwarded-For': ip },
      data: { username: uniqueUser(), password: 'password123' },
    });
    expect(resp4.status()).toBe(429);
  });

  /**
   * Duplicate username registration (409) still increments the counter.
   * The duplicate is only caught at the DB level, after rate limit check and increment.
   */
  test('duplicate username registration (409) counts toward rate limit', async ({ page }) => {
    await page.goto('/');
    const ip = uniqueTestIP();
    const existingUser = uniqueUser();

    // First registration succeeds
    const first = await page.request.post('/api/register', {
      headers: { 'X-Forwarded-For': ip },
      data: { username: existingUser, password: 'password123' },
    });
    expect(first.status()).toBe(201);

    // Two duplicates — 409 but still increment
    for (let i = 0; i < 2; i++) {
      const resp = await page.request.post('/api/register', {
        headers: { 'X-Forwarded-For': ip },
        data: { username: existingUser, password: 'password123' },
      });
      expect(resp.status()).toBe(409);
    }

    // 4th attempt is blocked
    const resp4 = await page.request.post('/api/register', {
      headers: { 'X-Forwarded-For': ip },
      data: { username: uniqueUser(), password: 'password123' },
    });
    expect(resp4.status()).toBe(429);
  });

  /**
   * 429 on register has Retry-After header.
   * Register window is 1 hour = 3600 seconds.
   */
  test('429 register response has Retry-After within 1-hour window', async ({ page }) => {
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

    const retryAfterHeader = resp.headers()['retry-after'];
    expect(retryAfterHeader).toBeTruthy();
    const retryAfter = parseInt(retryAfterHeader, 10);
    expect(isNaN(retryAfter)).toBe(false);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(3600);
  });

  /**
   * 429 on register includes CORS headers.
   */
  test('429 register response includes CORS headers', async ({ page }) => {
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
    const headers = resp.headers();
    expect(headers['access-control-allow-origin']).toBeTruthy();
  });

  /**
   * Register limits are per-IP. Two different IPs have independent counters.
   */
  test('register limits are per-IP', async ({ page }) => {
    await page.goto('/');
    const ip1 = uniqueTestIP();
    const ip2 = uniqueTestIP();

    // Exhaust ip1
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
    expect([201, 409]).toContain(allowed.status()); // 201 or 409, not 429
  });

  /**
   * 429 register response body: { error: 'Too many requests' }
   */
  test('429 register body has error: "Too many requests"', async ({ page }) => {
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
    const body = await resp.json();
    expect(body.error).toBe('Too many requests');
  });
});

// =============================================================================
// DELETE ACCOUNT RATE LIMITING
// Rate limit key: delete:<userId>
// Limit: 1 successful deletion per userId per 24 hours
// What increments: only a successful deletion
// What does NOT increment: wrong password (403), missing user (404), bad token (401)
// =============================================================================

test.describe('Account deletion rate limiting', () => {
  /**
   * Core: second deletion attempt after success returns 429.
   * The user is already gone, but the rate limit entry persists.
   */
  test('second deletion attempt is rate-limited (429)', async ({ page }) => {
    await page.goto('/');
    const ip = uniqueTestIP();
    const user = uniqueUser();

    const { token } = await apiRegisterWithIP(page, user, 'password123', ip);

    const del1 = await page.request.delete('/api/account', {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: JSON.stringify({ password: 'password123' }),
    });
    expect(del1.status()).toBe(200);

    const del2 = await page.request.delete('/api/account', {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: JSON.stringify({ password: 'password123' }),
    });
    expect(del2.status()).toBe(429);

    const body = await del2.json();
    expect(body.error).toBe('Too many requests');
  });

  /**
   * Wrong password does NOT increment the delete counter.
   * After multiple wrong-password attempts, the correct password must still work.
   */
  test('wrong password on delete does not consume the rate limit', async ({ page }) => {
    await page.goto('/');
    const ip = uniqueTestIP();
    const user = uniqueUser();

    const { token } = await apiRegisterWithIP(page, user, 'password123', ip);

    // Several wrong-password attempts — none should consume the limit
    for (let i = 0; i < 3; i++) {
      const resp = await page.request.delete('/api/account', {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        data: JSON.stringify({ password: 'WRONG_PASSWORD' }),
      });
      expect(resp.status()).toBe(403);
    }

    // Correct password must still work
    const resp = await page.request.delete('/api/account', {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: JSON.stringify({ password: 'password123' }),
    });
    expect(resp.status()).toBe(200);
  });

  /**
   * Delete rate limit is per userId, not per IP.
   * Two different users can each delete their accounts independently.
   */
  test('delete limits are per-userId, not per-IP', async ({ page }) => {
    await page.goto('/');
    const ip1 = uniqueTestIP();
    const ip2 = uniqueTestIP();
    const user1 = uniqueUser();
    const user2 = uniqueUser();

    const { token: token1 } = await apiRegisterWithIP(page, user1, 'password123', ip1);
    const { token: token2 } = await apiRegisterWithIP(page, user2, 'password123', ip2);

    // Delete user1
    const del1 = await page.request.delete('/api/account', {
      headers: { Authorization: `Bearer ${token1}`, 'Content-Type': 'application/json' },
      data: JSON.stringify({ password: 'password123' }),
    });
    expect(del1.status()).toBe(200);

    // User2 can still delete (different userId = different rate limit key)
    const del2 = await page.request.delete('/api/account', {
      headers: { Authorization: `Bearer ${token2}`, 'Content-Type': 'application/json' },
      data: JSON.stringify({ password: 'password123' }),
    });
    expect(del2.status()).toBe(200);
  });

  /**
   * 429 on delete includes Retry-After header within 24-hour window.
   */
  test('delete 429 has Retry-After within 24-hour window', async ({ page }) => {
    await page.goto('/');
    const ip = uniqueTestIP();
    const user = uniqueUser();

    const { token } = await apiRegisterWithIP(page, user, 'password123', ip);

    await page.request.delete('/api/account', {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: JSON.stringify({ password: 'password123' }),
    });

    const resp = await page.request.delete('/api/account', {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: JSON.stringify({ password: 'password123' }),
    });
    expect(resp.status()).toBe(429);

    const retryAfterHeader = resp.headers()['retry-after'];
    expect(retryAfterHeader).toBeTruthy();
    const retryAfter = parseInt(retryAfterHeader, 10);
    expect(isNaN(retryAfter)).toBe(false);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(86400); // 24 hours
  });

  /**
   * 429 on delete includes CORS headers.
   */
  test('delete 429 includes CORS headers', async ({ page }) => {
    await page.goto('/');
    const ip = uniqueTestIP();
    const user = uniqueUser();

    const { token } = await apiRegisterWithIP(page, user, 'password123', ip);

    await page.request.delete('/api/account', {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: JSON.stringify({ password: 'password123' }),
    });

    const resp = await page.request.delete('/api/account', {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: JSON.stringify({ password: 'password123' }),
    });
    expect(resp.status()).toBe(429);
    expect(resp.headers()['access-control-allow-origin']).toBeTruthy();
  });

  /**
   * DELETE without Authorization header returns 401 (auth check before rate limit).
   * Unauthenticated delete attempts should never reach the rate limit check.
   */
  test('delete without auth token returns 401 (auth before rate limit)', async ({ page }) => {
    await page.goto('/');

    const resp = await page.request.delete('/api/account', {
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({ password: 'password123' }),
    });
    expect(resp.status()).toBe(401);
  });

  /**
   * Malformed JSON body on delete returns 400 (not 429).
   * The body parse happens AFTER the rate limit check, so this test
   * verifies the rate limit itself is not triggering.
   * This test uses a fresh user (count=0) to confirm 400 is returned.
   */
  test('malformed JSON on delete returns 400 when user has not yet deleted', async ({ page }) => {
    await page.goto('/');
    const ip = uniqueTestIP();
    const user = uniqueUser();

    const { token } = await apiRegisterWithIP(page, user, 'password123', ip);

    const resp = await page.request.fetch('/api/account', {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      data: 'not valid json{',
    });
    expect(resp.status()).toBe(400);
  });
});

// =============================================================================
// IP HEADER INJECTION / BYPASS
// =============================================================================

test.describe('IP header handling and bypass', () => {
  /**
   * CF-Connecting-IP takes precedence over X-Forwarded-For.
   * Tests the header priority order: CF-Connecting-IP > X-Forwarded-For > "unknown".
   * When CF-Connecting-IP is present, X-Forwarded-For is ignored for rate limiting.
   */
  test('CF-Connecting-IP takes precedence over X-Forwarded-For', async ({ page }) => {
    await page.goto('/');
    const cfIP = uniqueTestIP();
    const fwdIP = uniqueTestIP();

    // Exhaust bucket using CF-Connecting-IP
    for (let i = 0; i < 5; i++) {
      await page.request.post('/api/login', {
        headers: {
          'CF-Connecting-IP': cfIP,
          'X-Forwarded-For': fwdIP,
        },
        data: { username: 'nosuchuser', password: 'wrongpass' },
      });
    }

    // CF-IP bucket is exhausted — still blocked even when we change X-Forwarded-For
    const stillBlocked = await page.request.post('/api/login', {
      headers: {
        'CF-Connecting-IP': cfIP,
        'X-Forwarded-For': uniqueTestIP(), // different fwd IP
      },
      data: { username: 'nosuchuser', password: 'wrongpass' },
    });
    expect(stillBlocked.status()).toBe(429);

    // But the fwdIP bucket itself is NOT exhausted (CF-IP was used, not fwdIP)
    const fwdIPNotBlocked = await page.request.post('/api/login', {
      headers: { 'X-Forwarded-For': fwdIP },
      data: { username: 'nosuchuser', password: 'wrongpass' },
    });
    // fwdIP is independent — should get 401 (wrong credentials), not 429
    expect(fwdIPNotBlocked.status()).toBe(401);
  });

  /**
   * In local dev (no CF-Connecting-IP), X-Forwarded-For creates independent buckets.
   * Each unique header value gets its own rate limit counter.
   */
  test('X-Forwarded-For creates independent rate limit buckets in local dev', async ({ page }) => {
    await page.goto('/');
    const ip1 = uniqueTestIP();
    const ip2 = uniqueTestIP();

    // Exhaust ip1 bucket
    for (let i = 0; i < 5; i++) {
      await page.request.post('/api/login', {
        headers: { 'X-Forwarded-For': ip1 },
        data: { username: 'nosuchuser', password: 'wrongpass' },
      });
    }

    // ip1 is blocked
    const blockedResp = await page.request.post('/api/login', {
      headers: { 'X-Forwarded-For': ip1 },
      data: { username: 'nosuchuser', password: 'wrongpass' },
    });
    expect(blockedResp.status()).toBe(429);

    // ip2 is NOT blocked (separate bucket)
    const bypassResp = await page.request.post('/api/login', {
      headers: { 'X-Forwarded-For': ip2 },
      data: { username: 'nosuchuser', password: 'wrongpass' },
    });
    expect(bypassResp.status()).toBe(401); // wrong creds, not rate-limited
  });
});
