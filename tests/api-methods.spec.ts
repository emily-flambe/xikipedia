/**
 * API Method Not Allowed Tests
 *
 * Verifies that known API endpoints return 405 Method Not Allowed with
 * correct Allow headers when accessed with the wrong HTTP method.
 *
 * Run with: npx playwright test tests/api-methods.spec.ts
 */

import { test, expect } from '@playwright/test';

const BASE_URL =
  process.env.PLAYWRIGHT_BASE_URL || 'https://xikipedia.emily-cogsdill.workers.dev';

test.describe('API 405 Method Not Allowed', () => {
  const wrongMethodCases: Array<{
    path: string;
    method: string;
    expectedAllow: string;
  }> = [
    { path: '/api/register', method: 'GET', expectedAllow: 'POST' },
    { path: '/api/login', method: 'PUT', expectedAllow: 'POST' },
    { path: '/api/logout', method: 'GET', expectedAllow: 'POST' },
    { path: '/api/me', method: 'POST', expectedAllow: 'GET' },
    { path: '/api/preferences', method: 'POST', expectedAllow: 'GET, PUT' },
    { path: '/api/account', method: 'GET', expectedAllow: 'DELETE' },
    { path: '/api/password', method: 'GET', expectedAllow: 'POST' },
  ];

  for (const { path, method, expectedAllow } of wrongMethodCases) {
    test(`${method} ${path} → 405 with Allow: ${expectedAllow}`, async ({ playwright }) => {
      const ctx = await playwright.request.newContext({ baseURL: BASE_URL });
      const response = await ctx.fetch(path, { method });
      expect(response.status()).toBe(405);
      expect(response.headers()['allow']).toBe(expectedAllow);
      const body = await response.json();
      expect(body.error).toContain('not allowed');
      await ctx.dispose();
    });
  }

  test('GET /api/preferences → not 405 (correct method)', async ({ playwright }) => {
    const ctx = await playwright.request.newContext({ baseURL: BASE_URL });
    const response = await ctx.get('/api/preferences');
    // Should be 401 (not authenticated) or 200, but NOT 405
    expect(response.status()).not.toBe(405);
    await ctx.dispose();
  });

  test('unknown API path still returns 404', async ({ playwright }) => {
    const ctx = await playwright.request.newContext({ baseURL: BASE_URL });
    const response = await ctx.get('/api/nonexistent');
    expect(response.status()).toBe(404);
    await ctx.dispose();
  });
});
