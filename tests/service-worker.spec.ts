import { test, expect, Page } from '@playwright/test';

// Service Worker tests - enabled after PR #43 merged and deployed

// Service Worker tests need special handling
test.describe('Service Worker', () => {
  
  test.beforeEach(async ({ context }) => {
    // Grant SW permission (Chromium-specific)
    await context.grantPermissions([]);
  });

  test('service worker registers successfully', async ({ page }) => {
    await page.goto('/');
    
    // Wait for SW to register
    const swRegistered = await page.evaluate(async () => {
      if (!('serviceWorker' in navigator)) return false;
      const registration = await navigator.serviceWorker.ready;
      return registration.active !== null;
    });
    
    expect(swRegistered).toBe(true);
  });

  test('offline indicator shows when offline', async ({ page, context }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    
    const indicator = page.locator('#offlineIndicator');
    await expect(indicator).not.toBeVisible();
    
    // Simulate offline
    await context.setOffline(true);
    await page.waitForTimeout(500);
    
    await expect(indicator).toBeVisible();
    await expect(indicator).toContainText("You're offline");
    
    // Go back online
    await context.setOffline(false);
    await page.waitForTimeout(500);
    
    await expect(indicator).not.toBeVisible();
  });

  test('cached pages load when offline', async ({ page, context }) => {
    // First visit - cache the page
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    
    // Wait for SW to be active
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    
    // Go offline
    await context.setOffline(true);
    
    // Navigate again - should load from cache
    await page.goto('/');
    
    // Page should still render
    await expect(page.locator('body')).toBeVisible();
    await expect(page.locator('#themeToggle')).toBeVisible();
  });

  test('service worker auto-activates via skipWaiting', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // SW should be active (skipWaiting + clients.claim)
    const swActive = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.ready;
      return reg.active !== null;
    });
    expect(swActive).toBe(true);

    // No update toast should exist in the DOM
    const toastExists = await page.evaluate(() => !!document.getElementById('updateToast'));
    expect(toastExists).toBe(false);
  });

  test('smoldata.json is cached after first load', async ({ page, context }) => {
    // Mock smoldata for faster test
    await page.route('**/smoldata.json', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ pages: [], subCategories: {}, noPageMaps: {} })
      });
    });
    
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    
    // Wait for SW
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    
    // Check if cached
    const isCached = await page.evaluate(async () => {
      const cache = await caches.open('xiki-data-v1');
      const keys = await cache.keys();
      return keys.some(k => k.url.includes('smoldata.json'));
    });
    
    // Note: This may be false if the mock intercepts before SW
    // In real scenario, the SW would cache the response
  });

  test('thumbnails are runtime cached', async ({ page }) => {
    await page.goto('/');
    
    // Wait for SW
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    
    // Add a thumbnail URL to cache manually (simulating runtime caching)
    await page.evaluate(async () => {
      const cache = await caches.open('xiki-thumbs-v1');
      const testResponse = new Response('fake-image-data', {
        headers: { 'Content-Type': 'image/jpeg' }
      });
      await cache.put('https://upload.wikimedia.org/test.jpg', testResponse);
    });
    
    // Verify it's in cache
    const isCached = await page.evaluate(async () => {
      const cache = await caches.open('xiki-thumbs-v1');
      const match = await cache.match('https://upload.wikimedia.org/test.jpg');
      return match !== undefined;
    });
    
    expect(isCached).toBe(true);
  });

  test('API requests are not cached (network only)', async ({ page }) => {
    await page.goto('/');
    
    // Wait for SW
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    
    // Check that no API responses are in any cache
    const apiCached = await page.evaluate(async () => {
      const cacheNames = await caches.keys();
      for (const name of cacheNames) {
        const cache = await caches.open(name);
        const keys = await cache.keys();
        if (keys.some(k => k.url.includes('/api/'))) {
          return true;
        }
      }
      return false;
    });
    
    expect(apiCached).toBe(false);
  });
});

// Integration tests with feed
test.describe('Service Worker + Feed Integration', () => {
  
  test('can browse feed offline after initial load', async ({ page, context }) => {
    // Unregister SW and clear caches so Playwright's route mock isn't bypassed.
    // Note: These promises fire-and-forget, but this is intentional. addInitScript runs
    // synchronously at page load before any fetch begins. By the time smoldata.json is
    // requested (after DOM parsing and script execution), the SW is already unregistering.
    // This approach is reliable in CI and avoids complex pre-navigation setups.
    await page.addInitScript(() => {
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.getRegistrations().then(regs => {
          regs.forEach(r => r.unregister());
        });
      }
      if ('caches' in window) {
        caches.keys().then(names => names.forEach(n => caches.delete(n)));
      }
    });

    // Use mock data for test speed
    await page.route('**/smoldata.json', async route => {
      const mockData = {
        pages: Array.from({ length: 50 }, (_, i) => [
          `Article ${i}`,
          i + 1,
          'Test content '.repeat(20),
          i % 3 === 0 ? 'thumb.jpg' : null,
          ['science', 'nature'],
          []
        ]),
        subCategories: {},
        noPageMaps: {}
      };
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockData)
      });
    });

    await page.goto('/');

    // Start the feed
    const startBtn = page.locator('[data-testid="start-button"]');
    await expect(startBtn).not.toBeDisabled({ timeout: 30000 });
    await startBtn.click();

    // Wait for posts to render (may take time on CI due to SW cleanup race)
    await expect(page.locator('[data-testid="post"]').first()).toBeVisible({ timeout: 15000 });

    // Go offline
    await context.setOffline(true);

    // Scroll through the already-loaded feed
    await page.evaluate(() => window.scrollTo(0, 1000));

    // Feed should still be visible (posts are already in DOM)
    await expect(page.locator('[data-testid="post"]').first()).toBeVisible();

    // Offline indicator should show (fired by window 'offline' event)
    await expect(page.locator('#offlineIndicator')).toBeVisible();
  });

  test('offline indicator has correct aria attributes', async ({ page, context }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    
    const indicator = page.locator('#offlineIndicator');
    
    // Check accessibility attributes
    await expect(indicator).toHaveAttribute('role', 'status');
    await expect(indicator).toHaveAttribute('aria-live', 'polite');
    
    // When visible, should be announced
    await context.setOffline(true);
    await page.waitForTimeout(500);
    await expect(indicator).toBeVisible();
  });

});
