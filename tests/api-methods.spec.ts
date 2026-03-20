/**
 * API Method Not Allowed Tests
 *
 * Verifies that known API endpoints return 405 Method Not Allowed with
 * correct Allow headers when accessed with the wrong HTTP method.
 *
 * Run with: npx playwright test tests/api-methods.spec.ts
 */

import { test, expect } from '@playwright/test';

test.describe('API 405 Method Not Allowed', () => {
  const wrongMethodCases: Array<{
    path: string;
    method: string;
    expectedAllow: string;
  }> = [
    { path: '/api/register', method: 'GET', expectedAllow: 'OPTIONS, POST' },
    { path: '/api/login', method: 'PUT', expectedAllow: 'OPTIONS, POST' },
    { path: '/api/logout', method: 'GET', expectedAllow: 'OPTIONS, POST' },
    { path: '/api/me', method: 'POST', expectedAllow: 'OPTIONS, GET' },
    { path: '/api/preferences', method: 'POST', expectedAllow: 'OPTIONS, GET, PUT' },
    { path: '/api/account', method: 'GET', expectedAllow: 'OPTIONS, DELETE' },
    { path: '/api/password', method: 'GET', expectedAllow: 'OPTIONS, POST' },
  ];

  for (const { path, method, expectedAllow } of wrongMethodCases) {
    test(`${method} ${path} → 405 with Allow: ${expectedAllow}`, async ({ request }) => {
      const response = await request.fetch(path, { method });
      expect(response.status()).toBe(405);
      expect(response.headers()['allow']).toBe(expectedAllow);
      const body = await response.json();
      expect(body.error).toContain('not allowed');
    });
  }

  test('GET /api/preferences → not 405 (correct method)', async ({ request }) => {
    const response = await request.get('/api/preferences');
    // Should be 401 (not authenticated) or 200, but NOT 405
    expect(response.status()).not.toBe(405);
  });

  test('unknown API path still returns 404', async ({ request }) => {
    const response = await request.get('/api/nonexistent');
    expect(response.status()).toBe(404);
  });
});
