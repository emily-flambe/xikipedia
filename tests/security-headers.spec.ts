/**
 * Security Header Tests
 *
 * Verifies that all security headers are present and correct on responses.
 * Uses Playwright's API request context (no browser needed).
 *
 * Run with: npx playwright test tests/security-headers.spec.ts
 */

import { test, expect } from '@playwright/test';

const BASE_URL =
  process.env.PLAYWRIGHT_BASE_URL || 'https://xikipedia.emily-cogsdill.workers.dev';

/** Expected security headers and their exact values. */
const EXPECTED_HEADERS: Record<string, string> = {
  'strict-transport-security': 'max-age=31536000; includeSubDomains; preload',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
};

/** CSP directives that must appear in the Content-Security-Policy header. */
const EXPECTED_CSP_DIRECTIVES = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' https://commons.wikimedia.org https://upload.wikimedia.org data:",
  "connect-src 'self'",
  "worker-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
];

test.describe('Security Headers', () => {
  test.describe('Main page (/)', () => {
    let headers: Record<string, string>;

    test.beforeAll(async ({ playwright }) => {
      const ctx = await playwright.request.newContext({ baseURL: BASE_URL });
      const response = await ctx.get('/');
      expect(response.status()).toBe(200);
      headers = response.headers();
      await ctx.dispose();
    });

    for (const [header, expected] of Object.entries(EXPECTED_HEADERS)) {
      test(`has ${header}`, () => {
        expect(headers[header]).toBe(expected);
      });
    }

    test('has Content-Security-Policy with all directives', () => {
      const csp = headers['content-security-policy'];
      expect(csp).toBeDefined();
      for (const directive of EXPECTED_CSP_DIRECTIVES) {
        expect(csp, `Missing CSP directive: ${directive}`).toContain(directive);
      }
    });

  });

  test.describe('API endpoint (/api/user)', () => {
    let headers: Record<string, string>;

    test.beforeAll(async ({ playwright }) => {
      const ctx = await playwright.request.newContext({ baseURL: BASE_URL });
      // /api/user returns 401 when not authenticated, but headers should still be set
      const response = await ctx.get('/api/user');
      headers = response.headers();
      await ctx.dispose();
    });

    for (const [header, expected] of Object.entries(EXPECTED_HEADERS)) {
      test(`has ${header}`, () => {
        expect(headers[header]).toBe(expected);
      });
    }

    test('has Content-Security-Policy with all directives', () => {
      const csp = headers['content-security-policy'];
      expect(csp).toBeDefined();
      for (const directive of EXPECTED_CSP_DIRECTIVES) {
        expect(csp, `Missing CSP directive: ${directive}`).toContain(directive);
      }
    });

    test('has X-Request-Id as a valid UUID', () => {
      const requestId = headers['x-request-id'];
      expect(requestId).toBeDefined();
      expect(requestId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
    });

    test('has Server-Timing header', () => {
      expect(headers['server-timing']).toMatch(/^total;dur=\d+$/);
    });
  });

  test('X-Request-Id is unique per request', async ({ playwright }) => {
    const ctx = await playwright.request.newContext({ baseURL: BASE_URL });
    const [r1, r2] = await Promise.all([ctx.get('/api/user'), ctx.get('/api/user')]);
    const id1 = r1.headers()['x-request-id'];
    const id2 = r2.headers()['x-request-id'];
    expect(id1).toBeDefined();
    expect(id2).toBeDefined();
    expect(id1).not.toBe(id2);
    await ctx.dispose();
  });
});
