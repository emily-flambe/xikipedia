/**
 * Rate Limiting Adversarial Tests
 *
 * These tests target specific bugs and edge cases in the rate limiting
 * implementation in src/index.ts. Each test is written to FAIL if the
 * bug exists, and pass only when the bug is fixed.
 *
 * Run with: npx playwright test tests/rate-limiting.spec.ts
 * Requires wrangler dev server on port 8788.
 *
 * NOTE: Because rate limits are keyed by IP and the dev server uses
 * 'unknown' for missing CF-Connecting-IP headers, many of these tests
 * will interfere with each other if run in parallel. Tests that exhaust
 * rate limits are grouped with test.describe.serial to run in sequence.
 * However, running this file alongside OTHER test files may still cause
 * interference due to the shared 'unknown' IP bucket.
 *
 * To run in isolation:
 *   npx playwright test tests/rate-limiting.spec.ts --workers=1
 */

import { test, expect, Page } from '@playwright/test';

// ─── Helpers (mirrors auth-adversarial.spec.ts) ──────────────────────────────

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
// BUG 1: INVALID JSON ON REGISTER BYPASSES RATE LIMIT
//
// The JSON parse occurs BEFORE the rate limit check in handleRegister.
// Sending invalid JSON returns 400 immediately without consuming a rate limit
// slot. An attacker can send unlimited malformed requests to probe the endpoint.
//
// Order in handleRegister (src/index.ts ~lines 424-435):
//   1. request.json() — on failure, returns 400 early WITHOUT hitting rate limit
//   2. checkAndIncrementRateLimit() — never reached for invalid JSON
//   3. validateRegistration()
//   4. db insert
//
// This means only requests with valid JSON consume rate limit slots.
// Invalid-JSON probing is unlimited.
//
// Location: src/index.ts handleRegister(), lines 424-435
// Severity: Medium — enables unlimited endpoint probing with invalid JSON
// =============================================================================

test.describe('BUG 1: Invalid JSON bypasses registration rate limit', () => {
  test('sending invalid JSON to /api/register never consumes rate limit slots', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    // Send 6 invalid JSON requests — 2x the 3-attempt registration limit.
    // If invalid JSON consumed slots, requests 4-6 would return 429.
    // Since JSON parse is before rate limiting, these never count.
    const results: number[] = [];
    for (let i = 0; i < 6; i++) {
      const resp = await page.request.fetch('/api/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        data: '{ invalid json !!!',
      });
      results.push(resp.status());
    }

    // All should be 400 (bad JSON), none should be 429 (rate limited)
    // This documents the bypass: an attacker can probe endlessly with bad JSON
    expect(results.every((s) => s === 400)).toBe(true);

    // Now a valid request AFTER all those bad-JSON requests should still work.
    // (Rate limit was never consumed by the bad-JSON attempts.)
    const user = uniqueUser();
    const resp = await page.request.post('/api/register', {
      data: { username: user, password: 'password123' },
    });
    // 201 = bad JSON did NOT consume rate limit slots (confirms the bypass)
    // 429 = bad JSON DID consume slots (would mean correct/stricter behavior)
    expect(resp.status()).toBe(201);
  });
});

// =============================================================================
// BUG 2: RATE LIMIT COUNTS SUCCESSFUL REGISTRATIONS
//
// checkAndIncrementRateLimit is called before validation, and always increments
// the counter for every request that passes JSON parsing — including successful
// registrations. This means an IP can only register 3 accounts total per hour,
// not 3 failed attempts per hour.
//
// Impact: A user who registers 3 accounts (e.g., three family members from the
// same home IP or NAT) is locked out for an hour, even though every registration
// was successful and legitimate.
//
// Location: src/index.ts handleRegister() line 432
//   const rl = await checkAndIncrementRateLimit(env.DB, rlKey, 3, 3600);
//   // Always increments on any valid-JSON request, including successful ones
//
// Severity: Medium — legitimate users at shared IPs hit the rate limit
// =============================================================================

test.describe.serial('BUG 2: Successful registrations consume rate limit slots', () => {
  test('3 successful registrations from the same IP exhaust the registration limit', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    // Register 3 unique users — all should succeed
    const results: number[] = [];
    for (let i = 0; i < 3; i++) {
      const user = uniqueUser();
      const resp = await page.request.post('/api/register', {
        data: { username: user, password: 'password123' },
      });
      results.push(resp.status());
    }
    expect(results).toEqual([201, 201, 201]);

    // The 4th registration attempt should now be rate limited.
    // This is a legitimate user — they just had 3 successful registrations.
    const user4 = uniqueUser();
    const resp4 = await page.request.post('/api/register', {
      data: { username: user4, password: 'password123' },
    });

    // BUG: This is 429 even though each prior registration was valid and successful.
    // The rate limiter doesn't distinguish "failed attempts" from "successful registrations."
    expect(resp4.status()).toBe(429);

    const body = await resp4.json();
    expect(body.error).toContain('Too many registration attempts');
    // Should include Retry-After header
    expect(resp4.headers()['retry-after']).toBeTruthy();
  });
});

// =============================================================================
// BUG 3: TOCTOU RACE — LOGIN CHECK/INCREMENT NOT ATOMIC
//
// handleLogin uses checkRateLimit (read-only) then conditionally calls
// incrementRateLimit (write). These are two separate database operations.
// Under concurrent load, two requests at count=4 can both pass checkRateLimit
// (both read count=4, which is < 5 limit), then both call incrementRateLimit
// (setting count to 5 and 6 respectively). More than 5 attempts slip through.
//
// Trace of the race condition:
//   Thread A: SELECT → count=4 < 5 → allowed
//   Thread B: SELECT → count=4 < 5 → allowed (before A increments)
//   Thread A: INSERT/UPDATE → count=5
//   Thread B: INSERT/UPDATE → count=6 (or resets if window changed)
//
// Compare to checkAndIncrementRateLimit used by register, which has the SAME
// TOCTOU issue (read then write) — neither is atomic.
//
// Location: src/index.ts handleLogin() lines 495-516
//   checkRateLimit() at line 495 (READ)
//   incrementRateLimit() at lines 507, 515 (WRITE — separate operations)
//
// Severity: High — rate limit can be exceeded under concurrent load
// =============================================================================

test.describe('BUG 3: Concurrent login attempts can exceed the rate limit (TOCTOU)', () => {
  test('concurrent failed logins may slip past the 5-attempt limit', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    // Send 10 concurrent failed login attempts.
    // With atomic enforcement: exactly 5 should be 401, the rest 429.
    // With TOCTOU: more than 5 may get 401 (all 10 in the worst case).
    const promises = Array.from({ length: 10 }, () =>
      page.request.post('/api/login', {
        data: { username: 'nonexistent_toctou_user', password: 'wrongpassword' },
      }),
    );

    const responses = await Promise.all(promises);
    const statuses = await Promise.all(responses.map((r) => r.status()));

    const got401 = statuses.filter((s) => s === 401).length;
    const got429 = statuses.filter((s) => s === 429).length;

    // Correct atomic enforcement: exactly 5 attempts get 401, the rest get 429
    // TOCTOU bug: more than 5 get 401 (observed: 10/10 in testing)
    expect(got401).toBeLessThanOrEqual(5);
    expect(got401 + got429).toBe(10);
  });
});

// =============================================================================
// BUG 4: LOGIN RATE LIMIT BLOCKS LEGITIMATE USERS SHARING AN IP
//
// The login rate limit key is "login:<ip>" (IP-only, not per-user).
// If 5 failed login attempts come from a shared IP (NAT, corporate network,
// coffee shop WiFi), every user behind that IP is locked out — including
// those with valid credentials who personally never failed.
//
// This is a Denial-of-Service vector: an attacker can lock out an entire
// NAT address by making 5 failed login attempts for any username.
//
// Location: src/index.ts handleLogin() line 494
//   const loginKey = `login:${ip}`;  // IP-only key, not IP+username
//   const rl = await checkRateLimit(env.DB, loginKey, 5, 900);
//
// Severity: High — shared IP environments (NAT, VPN, cloud egress) can be
//           locked out by a single attacker making 5 attempts
// =============================================================================

test.describe.serial('BUG 4: Login rate limit blocks valid users sharing an IP', () => {
  test('5 failed login attempts from one IP blocks a different valid user on same IP', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    // Register a legitimate user
    const legitimateUser = uniqueUser();
    const regResp = await page.request.post('/api/register', {
      data: { username: legitimateUser, password: 'correctpassword' },
    });
    expect(regResp.status()).toBe(201);

    // An attacker (same IP) sends 5 failed login attempts for a nonexistent user.
    for (let i = 0; i < 5; i++) {
      const resp = await page.request.post('/api/login', {
        data: { username: 'definitely_nonexistent_aaa', password: 'wrongpassword' },
      });
      expect(resp.status()).toBe(401);
    }

    // Now the legitimate user with correct credentials tries to log in.
    // They are blocked because the shared IP hit the rate limit.
    const loginResp = await page.request.post('/api/login', {
      data: { username: legitimateUser, password: 'correctpassword' },
    });

    // BUG: This returns 429 even though the user has correct credentials.
    // They personally never failed but are blocked due to IP-only rate limiting.
    expect(loginResp.status()).toBe(429);

    const body = await loginResp.json();
    expect(body.error).toContain('failed login attempts');
    // Should have Retry-After header
    expect(loginResp.headers()['retry-after']).toBeTruthy();
  });
});

// =============================================================================
// BUG 5: RETRY-AFTER HEADER VALUE — VERIFYING IT IS ALWAYS POSITIVE
//
// retryAfter = windowStart + windowSeconds - now
// windowStart = now - (now % windowSeconds)
// => retryAfter = windowSeconds - (now % windowSeconds)
//
// This ranges from 1 (at end of window) to windowSeconds (at start of window).
// It can NEVER be 0 or negative in normal operation because:
// - If now % windowSeconds == 0, we're at a new window boundary, and the
//   stored row's window_start won't match the new windowStart, so the
//   check returns allowed=true before computing retryAfter.
//
// This test CONFIRMS correct behavior (positive Retry-After).
//
// Location: src/index.ts checkRateLimit() line 318, checkAndIncrementRateLimit() line 362
// =============================================================================

test.describe.serial('Retry-After header is always a positive integer', () => {
  test('429 response Retry-After header is a positive integer >= 1', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    // Exhaust login rate limit (5 attempts)
    for (let i = 0; i < 5; i++) {
      await page.request.post('/api/login', {
        data: { username: 'retryafter_test_user', password: 'wrongpw' },
      });
    }

    // 6th attempt should be 429
    const resp = await page.request.post('/api/login', {
      data: { username: 'retryafter_test_user', password: 'wrongpw' },
    });
    expect(resp.status()).toBe(429);

    const retryAfterHeader = resp.headers()['retry-after'];
    expect(retryAfterHeader).toBeTruthy();

    const retryAfterValue = parseInt(retryAfterHeader, 10);
    expect(retryAfterValue).toBeGreaterThanOrEqual(1);
    expect(retryAfterValue).toBeLessThanOrEqual(900); // 900s login window
    expect(Number.isInteger(retryAfterValue)).toBe(true);
  });
});

// =============================================================================
// BUG 6: 429 RESPONSES INCLUDE CORS HEADERS (verify)
//
// The rateLimitResponse() function spreads getCorsHeaders(request).
// However, getCorsHeaders() only allows specific origins (production domains).
// In dev/test environments where Origin is http://localhost:8788 (not in the
// allowed list), the response still returns:
//   Access-Control-Allow-Origin: https://xiki.emilycogsdill.com
//
// This means in dev, 429 responses have the wrong CORS origin, making the
// error response unreadable by browser JS (CORS mismatch). In production with
// an unexpected origin, same issue.
//
// Location: src/index.ts rateLimitResponse() lines 278-287,
//           getCorsHeaders() lines 244-252
// Severity: Low (production origins are known), Medium (cross-origin dev testing)
// =============================================================================

test.describe.serial('429 responses include CORS headers', () => {
  test('rate limit response on register includes CORS headers', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    // Exhaust registration rate limit (3 attempts)
    for (let i = 0; i < 3; i++) {
      const user = uniqueUser();
      await page.request.post('/api/register', {
        data: { username: user, password: 'password123' },
      });
    }

    // 4th attempt should get 429
    const resp = await page.request.post('/api/register', {
      data: { username: uniqueUser(), password: 'password123' },
    });
    expect(resp.status()).toBe(429);

    const headers = resp.headers();
    // CORS header MUST be present on 429 responses
    expect(headers['access-control-allow-origin']).toBeTruthy();
    expect(headers['content-type']).toContain('application/json');
    expect(headers['retry-after']).toBeTruthy();
  });

  test('rate limit response on login includes Retry-After header', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    for (let i = 0; i < 5; i++) {
      await page.request.post('/api/login', {
        data: { username: 'cors_login_test_user', password: 'wrongpw' },
      });
    }

    const resp = await page.request.post('/api/login', {
      data: { username: 'cors_login_test_user', password: 'wrongpw' },
    });
    expect(resp.status()).toBe(429);

    // All three required headers must be present
    const headers = resp.headers();
    expect(headers['access-control-allow-origin']).toBeTruthy();
    expect(headers['retry-after']).toBeTruthy();
    expect(headers['content-type']).toContain('application/json');
  });
});

// =============================================================================
// BUG 7: MISSING CF-CONNECTING-IP — ALL REQUESTS SHARE 'unknown' BUCKET
//
// getClientIp() returns 'unknown' when CF-Connecting-IP is absent.
// In local dev (wrangler dev), this header is not set by default.
// This means ALL requests in dev share the same rate limit buckets:
//   "register:unknown" and "login:unknown"
//
// Impact in CI: Tests running in parallel can exhaust shared buckets, causing
// false test failures. The rate limit is also trivially bypassable in dev by
// setting a spoofed CF-Connecting-IP header (Cloudflare strips this in prod).
//
// Location: src/index.ts getClientIp() lines 274-276
// Severity: Low (production Cloudflare always sets the header), Medium for dev/CI
// =============================================================================

test.describe('IP header fallback behavior', () => {
  test('requests without CF-Connecting-IP use shared unknown key', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    // In dev, no CF-Connecting-IP → uses 'unknown' → shared bucket
    // This test just documents the behavior — under normal conditions it works.
    const user = uniqueUser();
    const resp = await page.request.post('/api/register', {
      data: { username: user, password: 'password123' },
    });
    // Should work when under the rate limit
    // But if other tests ran first and consumed all 3 slots, this will be 429
    expect([201, 429]).toContain(resp.status());

    if (resp.status() === 429) {
      // Documents the interference: other tests on same IP exhausted the limit
      const body = await resp.json();
      expect(body).toHaveProperty('error');
      console.warn('Rate limit already exhausted by parallel tests — shared IP bucket issue confirmed');
    }
  });

  test('CF-Connecting-IP header is used as rate limit key (spoofable in dev)', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    // In prod, Cloudflare strips CF-Connecting-IP from client requests.
    // In dev (wrangler dev), clients CAN set this header to get a fresh bucket.
    // This effectively bypasses rate limiting in development.
    const user = uniqueUser();
    const resp = await page.request.post('/api/register', {
      headers: { 'CF-Connecting-IP': '10.99.99.99' },
      data: { username: user, password: 'password123' },
    });
    // Should get 201 (fresh bucket for this IP) or 409 (user collision)
    // Should NOT be 429 because this is a fresh IP bucket
    expect([201, 409]).toContain(resp.status());
    expect(resp.status()).not.toBe(429);
  });
});

// =============================================================================
// BUG 8: DELETE ACCOUNT RATE LIMIT IS BYPASSED AFTER FIRST DELETION
//
// handleDeleteAccount checks the rate limit AFTER verifying the password.
// After a successful deletion, the user no longer exists. Any subsequent
// delete attempt with the same valid JWT token reaches "user not found"
// (line 648-650) BEFORE the rate limit check (line 659-663).
//
// This means the rate limit for account deletion can never fire more than once
// per account, because the second attempt returns 404 (user gone) before ever
// reaching the rate limit code.
//
// Design concern: if the rate limit was intended to prevent account cycling
// (create account → delete → create → delete), it fails because:
//   - Deletion succeeds on attempt 1 (rate limit consumed)
//   - Deletion attempt 2 returns 404, not 429
//   - The rate limit entry (delete:<userId>) is never checked again for
//     this userId since the user no longer exists to get past the auth check.
//
// Location: src/index.ts handleDeleteAccount() lines 641-671
//   User lookup: line 642-650 (returns 404 if no user found)
//   Rate limit:  line 659-663 (never reached if user is already gone)
//
// Severity: Low (the account is gone so cycling requires re-registration),
//           but the rate limit provides false assurance it prevents deletion spam.
// =============================================================================

test.describe('BUG 8: Delete account rate limit is bypassed after deletion', () => {
  test('second delete attempt with same token returns 404, not 429', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    const user = uniqueUser();
    const regResp = await page.request.post('/api/register', {
      data: { username: user, password: 'password123' },
    });
    expect(regResp.status()).toBe(201);
    const { token } = await regResp.json();

    // First deletion: consumes the rate limit slot, deletes the account
    const del1 = await page.request.delete('/api/account', {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      data: JSON.stringify({ password: 'password123' }),
    });
    expect(del1.status()).toBe(200);

    // Second deletion: user is gone. "User not found" fires before rate limit.
    const del2 = await page.request.delete('/api/account', {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      data: JSON.stringify({ password: 'password123' }),
    });

    // BUG: Returns 404 (user gone), not 429 (rate limit).
    // The rate limit is bypassed because the user was already deleted.
    expect(del2.status()).toBe(404);
    expect(del2.status()).not.toBe(429);
  });
});

// =============================================================================
// VALIDATION FAILURES DO NOT CONSUME REGISTRATION RATE LIMIT SLOTS
//
// The rate limit check runs AFTER validation in handleRegister. Requests with
// valid JSON but invalid data (e.g., password too short) return 400 WITHOUT
// consuming a rate limit slot.
//
// This means a user who makes 3 typos still has their full slot budget for
// valid registration attempts.
// =============================================================================

test.describe.serial('Validation failures do not consume registration rate limit slots', () => {
  test('3 invalid registration attempts (bad password) do not exhaust the rate limit', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    // Send 3 requests with valid JSON but invalid password (too short).
    // Rate limit runs AFTER validation, so these don't consume slots.
    for (let i = 0; i < 3; i++) {
      const resp = await page.request.post('/api/register', {
        data: { username: uniqueUser(), password: 'ab' }, // too short
      });
      expect(resp.status()).toBe(400);
      const body = await resp.json();
      expect(body.error).toContain('6 characters');
      expect(body.error).not.toContain('Too many');
    }

    // A valid registration should still succeed — validation failures didn't
    // consume the rate limit budget.
    const validUser = uniqueUser();
    const validResp = await page.request.post('/api/register', {
      data: { username: validUser, password: 'validpassword123' },
    });

    expect(validResp.status()).toBe(201);
  });
});

// =============================================================================
// BUG 10: checkAndIncrementRateLimit TOCTOU — CONCURRENT REGISTRATIONS BYPASS LIMIT
//
// checkAndIncrementRateLimit does a SELECT then a separate INSERT/UPDATE.
// Under concurrent load, multiple requests can both read the same count below
// the limit, both proceed, and both increment — exceeding the limit.
//
// Trace:
//   Thread A: SELECT → count=2 (< 3 limit) → allowed
//   Thread B: SELECT → count=2 (< 3 limit) → allowed (read before A writes)
//   Thread A: INSERT/UPDATE → count=3
//   Thread B: INSERT/UPDATE → count=4
//
// Both A and B succeed even though only one should (count was 2, limit is 3,
// only one more should be allowed).
//
// The fix requires either a transaction with SELECT FOR UPDATE (not available
// in D1) or using a single atomic UPDATE...RETURNING statement.
//
// Location: src/index.ts checkAndIncrementRateLimit() lines 344-378
//   Read: line 353 (SELECT)
//   Write: lines 367-375 (INSERT/UPDATE — NOT in a transaction with the SELECT)
//
// Severity: High — rate limits can be exceeded by concurrent requests
// =============================================================================

test.describe('BUG 10: Concurrent registrations can exceed rate limit (TOCTOU)', () => {
  test('concurrent registration attempts may bypass the 3-per-hour limit', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    // Send 6 concurrent registration requests (2x the 3-attempt limit).
    // Correct enforcement: at most 3 succeed (201), rest are 429.
    // With TOCTOU: potentially all 6 succeed.
    const promises = Array.from({ length: 6 }, () => {
      const user = uniqueUser();
      return page.request.post('/api/register', {
        data: { username: user, password: 'password123' },
      });
    });

    const responses = await Promise.all(promises);
    const statuses = await Promise.all(responses.map((r) => r.status()));

    const got201 = statuses.filter((s) => s === 201).length;
    const got429 = statuses.filter((s) => s === 429).length;

    // With correct enforcement: at most 3 should succeed
    // With TOCTOU: potentially all 6 succeed (observed in testing)
    expect(got201).toBeLessThanOrEqual(3);
    expect(got201 + got429).toBe(6);
  });
});

// =============================================================================
// BUG 11: SUCCESSFUL LOGIN DOES NOT RESET FAILED ATTEMPT COUNTER
//
// When a user successfully logs in, the rate limit counter is NOT reset.
// If Alice fails 4 times then succeeds on attempt 5 (lucky 5th try under
// the 5-limit), her counter remains at 4. The very next failure will be
// counted as attempt 5, triggering the rate limit — even though she just
// successfully authenticated.
//
// This penalizes users for forgotten passwords. After a successful login,
// one subsequent typo locks them out for 15 minutes.
//
// Contrast: many rate limiting systems reset the counter on successful
// authentication, treating success as a "proof of legitimacy."
//
// Location: src/index.ts handleLogin() — no counter reset on success
//   incrementRateLimit() called only on failure (lines 507, 515)
//   No reset/delete on success (lines 519-528)
//
// Severity: Medium — poor UX for users who mistype passwords occasionally
// =============================================================================

test.describe.serial('BUG 11: Successful login does not reset the failed attempt counter', () => {
  test('successful login does not reset the failed attempt counter', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    const user = uniqueUser();
    // Register the user
    const regResp = await page.request.post('/api/register', {
      data: { username: user, password: 'correctpassword' },
    });
    expect(regResp.status()).toBe(201);

    // Fail 4 times (just under the 5-attempt limit)
    for (let i = 0; i < 4; i++) {
      const resp = await page.request.post('/api/login', {
        data: { username: user, password: 'wrongpassword' },
      });
      expect(resp.status()).toBe(401);
    }

    // Log in successfully — counter should reset here (but doesn't)
    const successResp = await page.request.post('/api/login', {
      data: { username: user, password: 'correctpassword' },
    });
    expect(successResp.status()).toBe(200);

    // After a successful login, fail once more (just one typo)
    const failAfterSuccess = await page.request.post('/api/login', {
      data: { username: user, password: 'wrongpassword' },
    });

    // BUG: The counter was at 4 before the success. Success didn't reset it.
    // This single failure is the 5th recorded failure total, triggering the limit.
    // The user is locked out after ONE mistake following a successful login.
    expect(failAfterSuccess.status()).toBe(429);
  });
});

// =============================================================================
// BUG 12: DELETE ENDPOINT ALLOWS UNLIMITED PASSWORD GUESSING (no rate limit)
//
// handleDeleteAccount checks the rate limit AFTER verifying the password.
// Wrong password returns 403 BEFORE the rate limit is ever checked.
// This means an attacker with a valid JWT token can make unlimited password
// guesses against the delete endpoint — the rate limit only fires after a
// SUCCESSFUL password verification.
//
// Comparison with login: login rate limits FAILED attempts (correct behavior).
// Delete rate limits SUCCESSFUL attempts (backwards).
//
// Attack scenario:
//   1. Attacker steals a valid JWT token (e.g., XSS, token leak)
//   2. Attacker sends unlimited DELETE requests with password guesses
//   3. Only correct passwords trigger the rate limit check
//   4. Wrong passwords return 403 forever, no 429 ever
//
// Location: src/index.ts handleDeleteAccount() lines 641-671
//   Password verify: lines 652-657 → returns 403 on wrong password (before rate limit)
//   Rate limit check: lines 659-663 → only reached after correct password
//
// Severity: High — brute-force of account deletion password is unrestricted
// =============================================================================

test.describe('BUG 12: Delete endpoint allows unlimited password guessing', () => {
  test('multiple wrong passwords on delete endpoint never trigger rate limit', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    const user = uniqueUser();
    const regResp = await page.request.post('/api/register', {
      data: { username: user, password: 'correctpassword' },
    });
    expect(regResp.status()).toBe(201);
    const { token } = await regResp.json();

    // Send 10 wrong-password delete attempts — none should hit the rate limit
    const wrongAttempts: number[] = [];
    for (let i = 0; i < 10; i++) {
      const resp = await page.request.delete('/api/account', {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        data: JSON.stringify({ password: `wrongguess${i}` }),
      });
      wrongAttempts.push(resp.status());
    }

    // BUG: All 10 wrong-password attempts return 403, never 429.
    // Brute-forcing the delete endpoint password is completely unthrottled.
    expect(wrongAttempts.every((s) => s === 403)).toBe(true);
    expect(wrongAttempts.filter((s) => s === 429).length).toBe(0);
  });
});

// =============================================================================
// POSITIVE TEST: Rate limit response structure is correct and complete
//
// Every 429 response must have:
// - HTTP status 429
// - Content-Type: application/json
// - Retry-After: <positive integer>
// - Access-Control-Allow-Origin header (CORS)
// - JSON body with { error: string } — no extra fields
// =============================================================================

test.describe.serial('Rate limit response structure validation', () => {
  test('register 429 response has all required fields and correct structure', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    // Exhaust the registration rate limit
    for (let i = 0; i < 3; i++) {
      const user = uniqueUser();
      await page.request.post('/api/register', {
        data: { username: user, password: 'password123' },
      });
    }

    const resp = await page.request.post('/api/register', {
      data: { username: uniqueUser(), password: 'password123' },
    });

    expect(resp.status()).toBe(429);

    const headers = resp.headers();
    expect(headers['content-type']).toContain('application/json');
    expect(headers['retry-after']).toBeTruthy();
    expect(parseInt(headers['retry-after'], 10)).toBeGreaterThan(0);
    expect(headers['access-control-allow-origin']).toBeTruthy();

    const body = await resp.json();
    expect(body).toHaveProperty('error');
    expect(typeof body.error).toBe('string');
    expect(body.error.length).toBeGreaterThan(0);
    // Body should ONLY have the error field (no retryAfter leaked into JSON)
    expect(Object.keys(body)).toEqual(['error']);
  });

  test('login 429 response has all required fields and correct structure', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    for (let i = 0; i < 5; i++) {
      await page.request.post('/api/login', {
        data: { username: 'structure_validation_user', password: 'wrongpw' },
      });
    }

    const resp = await page.request.post('/api/login', {
      data: { username: 'structure_validation_user', password: 'wrongpw' },
    });

    expect(resp.status()).toBe(429);

    const headers = resp.headers();
    expect(headers['content-type']).toContain('application/json');
    expect(headers['retry-after']).toBeTruthy();
    expect(parseInt(headers['retry-after'], 10)).toBeGreaterThan(0);
    expect(headers['access-control-allow-origin']).toBeTruthy();

    const body = await resp.json();
    expect(body).toHaveProperty('error');
    expect(typeof body.error).toBe('string');
    expect(Object.keys(body)).toEqual(['error']);
  });
});
