import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

/**
 * Mock data to avoid 40MB download. Mirrors the format from xikipedia.spec.ts.
 * Article IDs start at 100 (i + 100).
 */
function generateMockData() {
  const pages = [];
  const categories = ['science', 'nature', 'animals', 'technology', 'music', 'art', 'history', 'sports'];
  for (let i = 0; i < 200; i++) {
    const cat1 = categories[i % categories.length];
    const cat2 = categories[(i + 3) % categories.length];
    const hasThumb = i % 3 === 0;
    pages.push([
      `Test Article ${i}`,
      i + 100,
      `This is the text content of article number ${i}. It contains enough text to pass the 100-character minimum filter. Here is additional padding content to make this article long enough to be included in the results.`,
      hasThumb ? `test_image_${i}.jpg` : null,
      [cat1, cat2],
      [((i + 1) % 200) + 100, ((i + 2) % 200) + 100]
    ]);
  }
  return {
    pages,
    subCategories: {
      science: ['physics', 'chemistry', 'biology'],
      nature: ['animals', 'plants'],
      animals: ['mammals', 'birds'],
    },
    noPageMaps: {}
  };
}

const MOCK_DATA = generateMockData();
const MOCK_JSON = JSON.stringify(MOCK_DATA);

// A real article ID from the mock data (first article: "Test Article 0", id=100)
const VALID_ARTICLE_ID = 100;
const VALID_ARTICLE_TITLE = 'Test Article 0';
// An ID that won't exist in mock data
const INVALID_ARTICLE_ID = 999999999;

async function setupMockRoute(page: Page) {
  // Unregister service worker to prevent cache-first from bypassing our mock
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

  await page.route('**/smoldata.json', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: MOCK_JSON,
    });
  });
}

/**
 * Navigate to the app with a ?article= param, wait for data to load,
 * then click start (guest path) and wait for posts.
 */
async function startFeedWithArticleParam(page: Page, articleId: number | string) {
  await setupMockRoute(page);
  await page.goto(`/?article=${articleId}`);

  const startBtn = page.locator('[data-testid="start-button"]');
  await expect(startBtn).not.toBeDisabled({ timeout: 30000 });
  await startBtn.click();
  await expect(page.locator('#startScreen')).not.toBeVisible({ timeout: 5000 });
}

test.describe('Shared article URL (?article= parameter)', () => {
  test('valid article ID shows that article first in the feed', async ({ page }) => {
    test.setTimeout(60000);
    await startFeedWithArticleParam(page, VALID_ARTICLE_ID);

    // First post in the feed should be the shared article
    const firstPost = page.locator('[data-testid="post"]').first();
    await expect(firstPost).toBeVisible({ timeout: 10000 });
    await expect(firstPost.locator('h1')).toHaveText(VALID_ARTICLE_TITLE);
  });

  test('invalid article ID shows error toast', async ({ page }) => {
    test.setTimeout(60000);
    await startFeedWithArticleParam(page, INVALID_ARTICLE_ID);

    // Error toast should appear
    const toast = page.locator('.toast-error');
    await expect(toast).toBeVisible({ timeout: 5000 });
    await expect(toast).toContainText('Article not found');
  });

  test('invalid article ID still loads the feed normally', async ({ page }) => {
    test.setTimeout(60000);
    await startFeedWithArticleParam(page, INVALID_ARTICLE_ID);

    // Feed posts should still appear despite the error
    await expect(page.locator('[data-testid="post"]').first()).toBeVisible({ timeout: 10000 });
  });

  test('URL param is removed from address bar after navigation', async ({ page }) => {
    test.setTimeout(60000);
    await setupMockRoute(page);
    await page.goto(`/?article=${VALID_ARTICLE_ID}`);

    // Wait for data to load (replaceState happens after data loads)
    const startBtn = page.locator('[data-testid="start-button"]');
    await expect(startBtn).not.toBeDisabled({ timeout: 30000 });

    // At this point replaceState has already been called (happens right after data loads)
    const url = page.url();
    expect(url).not.toContain('article=');
  });

  test('normal load without ?article= starts feed unaffected', async ({ page }) => {
    test.setTimeout(60000);
    await setupMockRoute(page);
    await page.goto('/');

    const startBtn = page.locator('[data-testid="start-button"]');
    await expect(startBtn).not.toBeDisabled({ timeout: 30000 });
    await startBtn.click();

    await expect(page.locator('#startScreen')).not.toBeVisible({ timeout: 5000 });
    await expect(page.locator('[data-testid="post"]').first()).toBeVisible({ timeout: 10000 });

    // No error toast should appear
    const toast = page.locator('.toast-error');
    await expect(toast).not.toBeVisible();
  });
});
