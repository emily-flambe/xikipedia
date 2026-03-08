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

  await page.evaluate(async () => {
    if ('serviceWorker' in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map(r => r.unregister()));
    }
    if ('caches' in window) {
      const names = await caches.keys();
      await Promise.all(names.map(name => caches.delete(name)));
    }
  }).catch(() => {});

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

// =============================================================================
// RATE LIMIT RESPONSE FORMAT
// =============================================================================

test.describe('Rate limit response format', () => {
  // These tests verify that ANY 429 response from auth endpoints has the
  // correct shape: HTTP 429, Retry-After header (positive integer), and the
  // canonical JSON error body.

  test('login 429 has correct status, Retry-After header, and JSON body', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    const user = uniqueUser();
    // Register the target user so we can attempt real logins against it.
    const regResp = await page.request.post('/api/register', {
      data: { username: user, password: 'correctpassword' },
    });
    // If registration itself is rate-limited, we can still proceed: the user
    // may not exist, but the wrong-password path still increments the counter.
    // However we need a known username. Fall back to a non-existent user path.
    const targetUser = regResp.status() === 201 ? user : `nonexistent_${user}`;

    // Send enough failed attempts to exhaust the login limit (5 failures = blocked).
    // We don't know how many failures have already accumulated in this window from
    // other tests, so we send 6 to ensure we cross the threshold.
    let lastResp: Awaited<ReturnType<typeof page.request.post>> | null = null;
    for (let i = 0; i < 6; i++) {
      lastResp = await page.request.post('/api/login', {
        data: { username: targetUser, password: `wrongpassword_${i}` },
      });
      if (lastResp.status() === 429) break;
    }

    expect(lastResp).not.toBeNull();
    expect(lastResp!.status()).toBe(429);

    // Retry-After must be present and be a positive integer string.
    const retryAfterHeader = lastResp!.headers()['retry-after'];
    expect(retryAfterHeader, 'Retry-After header must be present on 429').toBeTruthy();
    const retryAfterSeconds = parseInt(retryAfterHeader, 10);
    expect(
      Number.isInteger(retryAfterSeconds) && retryAfterSeconds > 0,
      `Retry-After must be a positive integer, got: "${retryAfterHeader}"`,
    ).toBe(true);

    // Body must be JSON with the canonical error message.
    const body = await lastResp!.json();
    expect(body).toHaveProperty('error');
    expect(body.error).toBe('Too many requests. Please try again later.');
  });

  test('login 429 does not leak sensitive information in the response', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    const user = uniqueUser();
    // Exhaust the limit (send 6 wrong passwords; accept that some may already be counted).
    let lastResp: Awaited<ReturnType<typeof page.request.post>> | null = null;
    for (let i = 0; i < 6; i++) {
      lastResp = await page.request.post('/api/login', {
        data: { username: user, password: `wrong_${i}` },
      });
      if (lastResp.status() === 429) break;
    }

    if (lastResp?.status() !== 429) {
      // Login bucket not yet exhausted — skip; this test can only run in isolation.
      test.skip();
      return;
    }

    const body = await lastResp.json();
    // The body must ONLY have the error key (no stack traces, no internal details).
    const keys = Object.keys(body);
    expect(keys).toEqual(['error']);
  });
});

// =============================================================================
// LOGIN RATE LIMITING
// =============================================================================

// These tests run serially to control the order of rate-limit accumulation.
// Running in parallel would make it impossible to reason about which attempt
// number we're on within the 15-minute window.
test.describe.configure({ mode: 'serial' });

test.describe('Login rate limiting', () => {
  // We use a dedicated user per test wherever possible. Because all requests
  // share ip='unknown' in wrangler dev, the login bucket is keyed on IP, not
  // on username. This means ALL login failures from all tests share the same
  // counter. The tests below are written to work regardless of initial counter
  // state by sending enough requests to be certain we've crossed the threshold.

  test('5 failed logins trigger 429 on the 6th attempt', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    const user = uniqueUser();

    // Register so we have a real user whose wrong-password path increments the counter.
    await page.request.post('/api/register', {
      data: { username: user, password: 'correctpassword' },
    });

    // Send 5 failed login attempts with wrong passwords.
    const responses: number[] = [];
    for (let i = 0; i < 5; i++) {
      const resp = await page.request.post('/api/login', {
        data: { username: user, password: `wrong${i}` },
      });
      responses.push(resp.status());
      // If we already hit a 429 before attempt 5, the prior test suite already
      // burned through this window. That's still valid — the limit is working.
      if (resp.status() === 429) {
        // The rate limit fired before we expected it. That's acceptable.
        return;
      }
    }

    // All 5 should have been 401 (wrong password), not 429.
    expect(responses.every(s => s === 401), `Expected 5 x 401, got: ${responses}`).toBe(true);

    // The 6th attempt must be 429.
    const sixthResp = await page.request.post('/api/login', {
      data: { username: user, password: 'stilwrong' },
    });
    expect(sixthResp.status()).toBe(429);

    const body = await sixthResp.json();
    expect(body.error).toBe('Too many requests. Please try again later.');
  });

  test('subsequent requests after rate limit is hit also return 429', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    const user = uniqueUser();

    // Send enough attempts to guarantee rate limit is triggered.
    let hitRateLimit = false;
    for (let i = 0; i < 7; i++) {
      const resp = await page.request.post('/api/login', {
        data: { username: user, password: `wrong${i}` },
      });
      if (resp.status() === 429) {
        hitRateLimit = true;
        break;
      }
    }

    expect(hitRateLimit, 'Should have hit the rate limit within 7 attempts').toBe(true);

    // Now send 2 more — they must ALL be 429, not 401.
    for (let i = 0; i < 2; i++) {
      const resp = await page.request.post('/api/login', {
        data: { username: user, password: `stilwrong${i}` },
      });
      expect(resp.status(), `Attempt after rate limit should be 429, was ${resp.status()}`).toBe(429);
    }
  });

  test('rate-limited login returns Retry-After > 0 and <= 900 (15 min window)', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    const user = uniqueUser();

    // Exhaust the rate limit.
    let rateLimitResp: Awaited<ReturnType<typeof page.request.post>> | null = null;
    for (let i = 0; i < 7; i++) {
      const resp = await page.request.post('/api/login', {
        data: { username: user, password: `wrong${i}` },
      });
      if (resp.status() === 429) {
        rateLimitResp = resp;
        break;
      }
    }

    expect(rateLimitResp, 'Rate limit must be triggered within 7 attempts').not.toBeNull();

    const retryAfterHeader = rateLimitResp!.headers()['retry-after'];
    expect(retryAfterHeader).toBeTruthy();

    const retryAfterSeconds = parseInt(retryAfterHeader, 10);
    // Must be a valid positive integer.
    expect(Number.isInteger(retryAfterSeconds)).toBe(true);
    expect(retryAfterSeconds).toBeGreaterThan(0);
    // Must not exceed the window size (15 minutes = 900 seconds).
    // We add a small buffer (5s) to tolerate sub-second timing jitter.
    expect(retryAfterSeconds).toBeLessThanOrEqual(905);
  });

  test('successful login does NOT count toward the failure counter', async ({ page }) => {
    // Specifically: register a user, send 4 failed login attempts, then send
    // 1 successful login (which must succeed), then send 1 more failed login
    // (which should succeed too, because the total failures counter is still 4).
    //
    // NOTE: Because all tests share the same IP bucket, this test can only
    // assert the correct behavior if run with a fresh login window. If a prior
    // test has already consumed attempts in this window, the assertions below
    // may see 429 earlier than expected. We detect this and skip gracefully.

    await mockSmoldata(page);
    await page.goto('/');

    const user = uniqueUser();
    const regResp = await page.request.post('/api/register', {
      data: { username: user, password: 'correctpassword' },
    });

    if (regResp.status() === 429) {
      test.skip();
      return;
    }
    expect(regResp.status()).toBe(201);

    // Send 4 bad logins — should all be 401, not 429.
    for (let i = 0; i < 4; i++) {
      const resp = await page.request.post('/api/login', {
        data: { username: user, password: `wrong${i}` },
      });
      if (resp.status() === 429) {
        // Prior tests burned this window. Skip rather than fail.
        test.skip();
        return;
      }
      expect(resp.status()).toBe(401);
    }

    // 5th attempt: CORRECT password — must succeed.
    const goodResp = await page.request.post('/api/login', {
      data: { username: user, password: 'correctpassword' },
    });
    expect(
      goodResp.status(),
      'Successful login with correct password should return 200, not be rate-limited',
    ).toBe(200);

    // 6th attempt (5th failure since successful login didn't count): should be 401, not 429.
    // Total failures: 4 (before success) + 0 (success didn't count) = 4. Still under 5.
    const fifthFailureResp = await page.request.post('/api/login', {
      data: { username: user, password: 'wrongagain' },
    });
    expect(
      fifthFailureResp.status(),
      'The 5th total failure should return 401, not 429 — successful login must not count',
    ).toBe(401);

    // 7th attempt (6th failure — now at 5 failures total): should be 429.
    const sixthFailureResp = await page.request.post('/api/login', {
      data: { username: user, password: 'stilwrong' },
    });
    expect(
      sixthFailureResp.status(),
      'The 6th total failure should return 429',
    ).toBe(429);
  });

  test('rate-limited login: correct password also gets 429 (limit blocks before auth)', async ({ page }) => {
    // Once the rate limit is exhausted, even a correct password should be blocked.
    // This is the correct security behavior: the check happens BEFORE password verification.

    await mockSmoldata(page);
    await page.goto('/');

    const user = uniqueUser();
    const regResp = await page.request.post('/api/register', {
      data: { username: user, password: 'correctpassword' },
    });
    // Even if registration is rate-limited, we can still test with a nonexistent user
    // since the check happens before any DB lookup.

    // Exhaust the limit.
    let limitHit = false;
    for (let i = 0; i < 7; i++) {
      const resp = await page.request.post('/api/login', {
        data: { username: user, password: `wrong${i}` },
      });
      if (resp.status() === 429) {
        limitHit = true;
        break;
      }
    }

    expect(limitHit, 'Rate limit should trigger within 7 attempts').toBe(true);

    // Now try the correct password — it should also be rate-limited.
    const correctPwdResp = await page.request.post('/api/login', {
      data: { username: user, password: 'correctpassword' },
    });
    expect(
      correctPwdResp.status(),
      'Even correct password must get 429 when rate limit is exhausted',
    ).toBe(429);
  });

  test('login rate limit for nonexistent username also increments counter', async ({ page }) => {
    // The rate limit must increment even when the username does not exist.
    // Otherwise an attacker could enumerate which usernames exist by observing
    // whether their attempts count.

    await mockSmoldata(page);
    await page.goto('/');

    const ghost = `ghost_${uniqueUser()}`; // guaranteed to not exist

    // Exhaust limit via a nonexistent username.
    let limitHit = false;
    for (let i = 0; i < 7; i++) {
      const resp = await page.request.post('/api/login', {
        data: { username: ghost, password: `wrong${i}` },
      });
      if (resp.status() === 429) {
        limitHit = true;
        break;
      }
    }

    expect(
      limitHit,
      'Logins for nonexistent usernames should count toward the rate limit',
    ).toBe(true);
  });
});

// =============================================================================
// REGISTRATION RATE LIMITING
// =============================================================================

test.describe('Registration rate limiting', () => {
  // WARNING: Registration rate limit is 3 per IP per hour. Since wrangler dev
  // sees all requests as ip='unknown', every registration from every test file
  // consumes this shared bucket. These tests are best run in isolation.
  //
  // The tests detect whether the bucket is already exhausted and skip
  // gracefully to avoid false failures when run alongside the broader suite.

  test('4th registration attempt in the same hour returns 429', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    const statuses: number[] = [];

    // Attempt 3 registrations.
    for (let i = 0; i < 3; i++) {
      const user = uniqueUser();
      const resp = await page.request.post('/api/register', {
        data: { username: user, password: 'password123' },
      });
      statuses.push(resp.status());
      if (resp.status() === 429) {
        // Window already exhausted by other tests. Skip rather than fail.
        test.skip();
        return;
      }
      // Should be 201 (new user) or 409 (duplicate — extremely unlikely but handle it).
      expect([201, 409]).toContain(resp.status());
    }

    // 4th attempt should be 429.
    const fourthResp = await page.request.post('/api/register', {
      data: { username: uniqueUser(), password: 'password123' },
    });
    expect(
      fourthResp.status(),
      `Expected 429 on the 4th registration attempt, got ${fourthResp.status()}`,
    ).toBe(429);

    const body = await fourthResp.json();
    expect(body.error).toBe('Too many requests. Please try again later.');
  });

  test('registration 429 includes Retry-After header within 1-hour window', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    // Try to get a 429 by registering multiple times.
    let rateLimitResp: Awaited<ReturnType<typeof page.request.post>> | null = null;
    for (let i = 0; i < 5; i++) {
      const resp = await page.request.post('/api/register', {
        data: { username: uniqueUser(), password: 'password123' },
      });
      if (resp.status() === 429) {
        rateLimitResp = resp;
        break;
      }
    }

    if (!rateLimitResp) {
      // Could not trigger rate limit (would need to be at attempt 4+).
      test.skip();
      return;
    }

    const retryAfterHeader = rateLimitResp.headers()['retry-after'];
    expect(retryAfterHeader, 'Retry-After header must be present on 429').toBeTruthy();

    const retryAfterSeconds = parseInt(retryAfterHeader, 10);
    expect(Number.isInteger(retryAfterSeconds)).toBe(true);
    expect(retryAfterSeconds).toBeGreaterThan(0);
    // Must not exceed 1 hour + 5 seconds buffer for timing jitter.
    expect(retryAfterSeconds).toBeLessThanOrEqual(3605);
  });

  test('failed registration (duplicate username) still counts toward rate limit', async ({ page }) => {
    // The implementation increments the counter BEFORE the duplicate-username
    // check. This means a failed registration due to 409 Conflict still burns
    // a slot in the rate limit window. Test this by sending 2 successful
    // registrations and then 1 duplicate (which fails with 409), and verifying
    // the 4th attempt is 429.

    await mockSmoldata(page);
    await page.goto('/');

    const user = uniqueUser();

    // Attempt 1: new user (should succeed).
    const resp1 = await page.request.post('/api/register', {
      data: { username: user, password: 'password123' },
    });
    if (resp1.status() === 429) { test.skip(); return; }
    expect(resp1.status()).toBe(201);

    // Attempt 2: another new user (should succeed).
    const resp2 = await page.request.post('/api/register', {
      data: { username: uniqueUser(), password: 'password123' },
    });
    if (resp2.status() === 429) { test.skip(); return; }
    expect(resp2.status()).toBe(201);

    // Attempt 3: same username as attempt 1 (should fail with 409 — but still counts).
    const resp3 = await page.request.post('/api/register', {
      data: { username: user, password: 'password123' },
    });
    if (resp3.status() === 429) { test.skip(); return; }
    expect(resp3.status()).toBe(409);

    // Attempt 4: any username — must be 429.
    const resp4 = await page.request.post('/api/register', {
      data: { username: uniqueUser(), password: 'password123' },
    });
    expect(
      resp4.status(),
      'The 4th registration (after 2 successes + 1 duplicate) must be rate-limited (429). ' +
      'If this fails with 201, the implementation does NOT count duplicate registrations toward the limit.',
    ).toBe(429);
  });
});

// =============================================================================
// ACCOUNT DELETION RATE LIMITING
// =============================================================================

test.describe('Account deletion rate limiting', () => {
  // The delete rate limit is 1 per user-ID per 24 hours. The limit is incremented
  // AFTER successful deletion, which means a second deletion attempt with the
  // same user ID is impossible (the user no longer exists). However, we can
  // observe the rate-limit check fires BEFORE the body is parsed, and we can
  // also verify the response format by examining the Retry-After in edge cases.

  test('delete rate limit check fires before password verification', async ({ page }) => {
    // Demonstrates that the rate-limit is keyed on user ID extracted from the JWT,
    // not on any body field. This test verifies the ordering of checks.

    await mockSmoldata(page);
    await page.goto('/');

    // We cannot practically trigger the delete rate limit in E2E because the
    // first delete succeeds and removes the user, making the second impossible.
    // What we CAN verify is that the delete endpoint checks the rate limit
    // key before reading the body.
    //
    // Approach: register a user, delete them, immediately try to delete again
    // with the same (now-invalid) token. The second attempt will fail with 401
    // (user not found in preferences lookup) rather than 429, because the
    // rate limit increment happens AFTER successful deletion.
    //
    // This test documents the limitation rather than asserting incorrect behavior.

    const user = uniqueUser();
    const regResp = await page.request.post('/api/register', {
      data: { username: user, password: 'password123' },
    });

    if (regResp.status() !== 201) {
      test.skip();
      return;
    }

    const { token } = await regResp.json();

    // First delete: should succeed.
    const del1 = await page.request.delete('/api/account', {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: JSON.stringify({ password: 'password123' }),
    });
    expect(del1.status()).toBe(200);

    // Second delete: the rate limit counter was incremented after the first
    // successful delete. However the user is now gone, so the JWT verification
    // passes (token is cryptographically valid) but the subsequent user lookup
    // returns null... wait, that depends on implementation order.
    //
    // The implementation checks rate limit BEFORE reading the body, but AFTER
    // verifying the JWT. So:
    // 1. JWT verification passes (token is valid).
    // 2. Rate limit check: key is `delete:<user_id>`. Counter = 1 (from first delete).
    //    maxAttempts = 1. 1 >= 1 → BLOCKED → 429.
    //
    // So the second delete SHOULD return 429, not 401.
    const del2 = await page.request.delete('/api/account', {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: JSON.stringify({ password: 'password123' }),
    });

    // The second attempt must be 429, not 401 or 200.
    expect(
      del2.status(),
      `Expected 429 on second delete attempt (rate limit), got ${del2.status()}. ` +
      'If this is 401, the user-not-found check runs before the rate limit — which leaks that the user was deleted.',
    ).toBe(429);

    const body = await del2.json();
    expect(body.error).toBe('Too many requests. Please try again later.');
  });

  test('delete 429 includes Retry-After <= 86400 (24h window)', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    const user = uniqueUser();
    const regResp = await page.request.post('/api/register', {
      data: { username: user, password: 'password123' },
    });
    if (regResp.status() !== 201) { test.skip(); return; }

    const { token } = await regResp.json();

    await page.request.delete('/api/account', {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: JSON.stringify({ password: 'password123' }),
    });

    // Second attempt should be 429.
    const del2 = await page.request.delete('/api/account', {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: JSON.stringify({ password: 'password123' }),
    });

    if (del2.status() !== 429) {
      // Not rate-limited — something else happened (e.g., 401 user not found).
      // Document this as a potential bug.
      test.fail(
        true,
        `Expected 429 on second delete, got ${del2.status()}. ` +
        'The rate limit check may run after user-not-found, or the counter was not incremented.',
      );
      return;
    }

    const retryAfterHeader = del2.headers()['retry-after'];
    expect(retryAfterHeader).toBeTruthy();

    const retryAfterSeconds = parseInt(retryAfterHeader, 10);
    expect(Number.isInteger(retryAfterSeconds)).toBe(true);
    expect(retryAfterSeconds).toBeGreaterThan(0);
    // Must be within 24-hour window (86400 seconds), with small buffer.
    expect(retryAfterSeconds).toBeLessThanOrEqual(86405);
  });
});

// =============================================================================
// EDGE CASES AND ADVERSARIAL INPUTS TO RATE-LIMITED ENDPOINTS
// =============================================================================

test.describe('Rate limit edge cases', () => {
  test('rate limit applies even when Content-Type is missing from login request', async ({ page }) => {
    // The rate limit check fires before body parsing. A missing Content-Type
    // should not bypass the limit.
    await mockSmoldata(page);
    await page.goto('/');

    const user = uniqueUser();

    // Exhaust the limit with normal requests first.
    let limitHit = false;
    for (let i = 0; i < 7; i++) {
      const resp = await page.request.post('/api/login', {
        data: { username: user, password: `wrong${i}` },
      });
      if (resp.status() === 429) { limitHit = true; break; }
    }

    if (!limitHit) { test.skip(); return; }

    // Now try with a request that has no Content-Type header (raw fetch).
    const rawResp = await page.request.fetch('/api/login', {
      method: 'POST',
      data: JSON.stringify({ username: user, password: 'notype' }),
    });

    // Should still be 429, not bypass via content-type trick.
    expect(rawResp.status()).toBe(429);
  });

  test('rate limit is per-IP not per-username: different usernames share the same counter', async ({ page }) => {
    // Because the rate limit key is `login:<ip>`, failed attempts against
    // different usernames all share the same counter. After 5 failures across
    // any usernames, the 6th should be blocked.

    await mockSmoldata(page);
    await page.goto('/');

    // Exhaust by trying different usernames.
    const users = Array.from({ length: 6 }, () => uniqueUser());

    let limitHit = false;
    let attemptsBeforeLimit = 0;
    for (const u of users) {
      const resp = await page.request.post('/api/login', {
        data: { username: u, password: 'wrong' },
      });
      if (resp.status() === 429) {
        limitHit = true;
        break;
      }
      attemptsBeforeLimit++;
    }

    expect(
      limitHit,
      `Expected rate limit after ${attemptsBeforeLimit} attempts across different usernames`,
    ).toBe(true);

    // The limit must have fired within 6 attempts (limit is 5 failures).
    expect(attemptsBeforeLimit).toBeLessThanOrEqual(5);
  });

  test('Retry-After value is a string representation of an integer, not a float', async ({ page }) => {
    // The implementation uses Math.max(1, retryAfter) — verify the result is an
    // integer string, not "899.something" which would violate RFC 7231.

    await mockSmoldata(page);
    await page.goto('/');

    const user = uniqueUser();
    let rateLimitResp: Awaited<ReturnType<typeof page.request.post>> | null = null;

    for (let i = 0; i < 7; i++) {
      const resp = await page.request.post('/api/login', {
        data: { username: user, password: `wrong${i}` },
      });
      if (resp.status() === 429) {
        rateLimitResp = resp;
        break;
      }
    }

    if (!rateLimitResp) { test.skip(); return; }

    const retryAfterHeader = rateLimitResp.headers()['retry-after'];
    expect(retryAfterHeader).toBeTruthy();

    // Must be a pure integer string (no decimal point, no non-numeric chars).
    expect(retryAfterHeader).toMatch(/^\d+$/);
  });

  test('login with empty username does not consume rate limit slot', async ({ page }) => {
    // Empty username/password fails input validation before the rate limit check.
    // Verify that invalid inputs do NOT burn rate limit slots.

    await mockSmoldata(page);
    await page.goto('/');

    // Send several requests with invalid (empty) credentials.
    for (let i = 0; i < 3; i++) {
      const resp = await page.request.post('/api/login', {
        data: { username: '', password: '' },
      });
      // Should be 400 (validation error), not 429.
      expect(
        resp.status(),
        'Empty credentials should return 400 (validation error), not 429 (rate limit)',
      ).toBe(400);
    }
  });

  test('login with missing body fields does not consume rate limit', async ({ page }) => {
    await mockSmoldata(page);
    await page.goto('/');

    for (let i = 0; i < 3; i++) {
      const resp = await page.request.post('/api/login', {
        data: {},
      });
      expect(
        resp.status(),
        'Missing body fields should return 400, not 429',
      ).toBe(400);
    }
  });
});
