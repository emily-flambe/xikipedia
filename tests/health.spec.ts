/**
 * Health Endpoint Tests
 *
 * Verifies the /api/health endpoint reports service status.
 *
 * Run with: npx playwright test tests/health.spec.ts
 */

import { test, expect } from '@playwright/test';

const BASE_URL =
  process.env.PLAYWRIGHT_BASE_URL || 'https://xikipedia.emily-cogsdill.workers.dev';

test.describe('Health endpoint', () => {
  test('GET /api/health returns healthy status', async ({ playwright }) => {
    const ctx = await playwright.request.newContext({ baseURL: BASE_URL });
    const response = await ctx.get('/api/health');
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.status).toBe('healthy');
    expect(body.checks.database).toBe('ok');
    expect(body.checks.storage).toBe('ok');
    await ctx.dispose();
  });

  test('GET /api/health includes CORS and security headers', async ({ playwright }) => {
    const ctx = await playwright.request.newContext({ baseURL: BASE_URL });
    const response = await ctx.get('/api/health');
    const headers = response.headers();
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['x-request-id']).toBeDefined();
    expect(headers['content-type']).toContain('application/json');
    await ctx.dispose();
  });

  test('GET /api/health returns X-Request-Id and Server-Timing', async ({ playwright }) => {
    const ctx = await playwright.request.newContext({ baseURL: BASE_URL });
    const response = await ctx.get('/api/health');
    const headers = response.headers();
    expect(headers['x-request-id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(headers['server-timing']).toMatch(/^total;dur=\d+$/);
    await ctx.dispose();
  });

  test('POST /api/health returns 405', async ({ playwright }) => {
    const ctx = await playwright.request.newContext({ baseURL: BASE_URL });
    const response = await ctx.post('/api/health');
    expect(response.status()).toBe(405);
    await ctx.dispose();
  });
});
