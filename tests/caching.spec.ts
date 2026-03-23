import { test, expect } from '@playwright/test';

test.describe('ETag and conditional request support', () => {
  // ETag tests require R2 storage access. In CI without Cloudflare credentials,
  // R2 data files return 404, so these tests are skipped when ETags aren't available.

  test('GET /smoldata.json returns ETag header', async ({ request }) => {
    // Use HEAD to avoid downloading the full ~215MB file
    const response = await request.head('/smoldata.json');
    test.skip(response.status() === 404, 'R2 data not available (CI without credentials)');
    expect(response.status()).toBe(200);
    const etag = response.headers()['etag'];
    expect(etag).toBeTruthy();
    // ETag should be quoted per HTTP spec (strong "..." or weak W/"...")
    expect(etag).toMatch(/^(W\/)?".*"$/);
  });

  test('GET /smoldata.json with matching If-None-Match returns 304', async ({
    request,
  }) => {
    // First get the ETag via HEAD
    const head = await request.head('/smoldata.json');
    test.skip(head.status() === 404, 'R2 data not available (CI without credentials)');
    const etag = head.headers()['etag'];
    expect(etag).toBeTruthy();

    // Now request with If-None-Match
    const response = await request.get('/smoldata.json', {
      headers: { 'If-None-Match': etag },
    });
    expect(response.status()).toBe(304);
  });

  test('GET /smoldata.json with non-matching If-None-Match returns 200 with ETag', async ({
    request,
  }) => {
    const response = await request.get('/smoldata.json', {
      headers: { 'If-None-Match': '"not-a-real-etag"' },
    });
    test.skip(response.status() === 404, 'R2 data not available (CI without credentials)');
    expect(response.status()).toBe(200);
    expect(response.headers()['etag']).toBeTruthy();
  });

  test('GET /index.json returns ETag header', async ({ request }) => {
    const response = await request.head('/index.json');
    test.skip(response.status() === 404, 'R2 data not available (CI without credentials)');
    expect(response.status()).toBe(200);
    const etag = response.headers()['etag'];
    expect(etag).toBeTruthy();
    expect(etag).toMatch(/^(W\/)?".*"$/);
  });

  test('GET /index.json with matching If-None-Match returns 304', async ({
    request,
  }) => {
    // First get the ETag
    const head = await request.head('/index.json');
    test.skip(head.status() === 404, 'R2 data not available (CI without credentials)');
    const etag = head.headers()['etag'];
    expect(etag).toBeTruthy();

    // Now request with If-None-Match
    const response = await request.get('/index.json', {
      headers: { 'If-None-Match': etag },
    });
    expect(response.status()).toBe(304);
  });
});
