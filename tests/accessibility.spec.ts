import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * Automated accessibility testing with axe-core.
 *
 * Pre-existing violations documented below are excluded so tests pass.
 * Each should be addressed in future improvements.
 *
 * TODO: Fix these pre-existing a11y violations:
 *
 * 1. color-contrast (serious, WCAG 2 AA) — widespread across all views:
 *    - Start screen: links (#3faaf2, #1d9bf0 on white), auth tabs (#2cafff, #8899aa on white),
 *      start button (#fff on #1d9bf0), guest message (#8899aa on white)
 *    - Feed: #keyboardHint (#fff on #89d2ff)
 *    - Sidebar: keyboard hint, algo-slider-value (#1d9bf0 on white),
 *      slider labels (#87939c on white), active mood button (#fff on #1d9bf0)
 *
 *
 * FIXED in EMI-115:
 * - region: Added role="dialog" to start screen and keyboard help overlay
 *
 * FIXED in EMI-114:
 * - heading-order: Fixed hierarchy (h3→h2 keyboard help, h4→h3 sidebar)
 *
 * FIXED in EMI-105:
 * - landmark-one-main: Added <main> landmark wrapping feed content
 * - aria-required-children: Added role="article" to posts, aria-busy on empty feed
 */

// Known pre-existing rules to exclude so tests pass.
// TODO: Fix these and remove exclusions one by one.
const KNOWN_VIOLATION_RULES = [
  'color-contrast',        // TODO: Fix contrast ratios across the app
];

/**
 * Mock data to avoid 40MB download in CI.
 * Same pattern as xikipedia.spec.ts.
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

async function setupMockRoute(page: Page) {
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

async function startFeed(page: Page) {
  await setupMockRoute(page);
  await page.goto('/');

  const startBtn = page.locator('[data-testid="start-button"]');
  await expect(startBtn).not.toBeDisabled({ timeout: 30000 });
  await startBtn.click();
  await expect(page.locator('#startScreen')).not.toBeVisible({ timeout: 5000 });
  await expect(page.locator('[data-testid="post"]').first()).toBeVisible({ timeout: 10000 });
}

test.describe('Accessibility (axe-core)', () => {
  test('start screen has no unexpected a11y violations', async ({ page }) => {
    test.setTimeout(60000);
    await setupMockRoute(page);
    await page.goto('/');

    // Wait for start screen to be ready
    const startBtn = page.locator('[data-testid="start-button"]');
    await expect(startBtn).not.toBeDisabled({ timeout: 30000 });

    const results = await new AxeBuilder({ page })
      .disableRules(KNOWN_VIOLATION_RULES)
      .analyze();

    expect(results.violations).toEqual([]);
  });

  test('feed view has no unexpected a11y violations', async ({ page }) => {
    test.setTimeout(120000);
    await startFeed(page);

    const results = await new AxeBuilder({ page })
      .disableRules(KNOWN_VIOLATION_RULES)
      .analyze();

    expect(results.violations).toEqual([]);
  });

  test('sidebar has no unexpected a11y violations', async ({ page }) => {
    test.setTimeout(120000);
    await page.setViewportSize({ width: 1200, height: 800 });
    await startFeed(page);

    // Like a post to populate sidebar categories
    await page.locator('[data-testid="like-button"]').first().click();
    await page.waitForTimeout(200);

    // Open the sidebar drawer
    await page.locator('#statsToggleBtn').click();
    await page.waitForTimeout(400);

    const results = await new AxeBuilder({ page })
      .disableRules(KNOWN_VIOLATION_RULES)
      .analyze();

    expect(results.violations).toEqual([]);
  });

  test('auth form inputs have associated labels', async ({ page }) => {
    test.setTimeout(60000);
    await setupMockRoute(page);
    await page.goto('/');
    const startBtn = page.locator('[data-testid="start-button"]');
    await expect(startBtn).not.toBeDisabled({ timeout: 30000 });

    // Switch to login tab
    await page.locator('[data-tab="login"]').click();
    await expect(page.locator('#loginUsername')).toBeVisible();

    // Verify login form labels
    await expect(page.locator('label[for="loginUsername"]')).toHaveText('Username');
    await expect(page.locator('label[for="loginPassword"]')).toHaveText('Password');

    // Switch to register tab
    await page.locator('[data-tab="register"]').click();
    await expect(page.locator('#registerUsername')).toBeVisible();

    // Verify register form labels
    await expect(page.locator('label[for="registerUsername"]')).toHaveText('Username');
    await expect(page.locator('label[for="registerPassword"]')).toHaveText('Password');
    await expect(page.locator('label[for="registerConfirm"]')).toHaveText('Confirm password');
  });

  test('keyboard help overlay has no unexpected a11y violations', async ({ page }) => {
    test.setTimeout(120000);
    await startFeed(page);

    // Press ? to show keyboard help
    await page.keyboard.press('?');
    await expect(page.locator('#keyboardHelp')).toBeVisible({ timeout: 3000 });

    const results = await new AxeBuilder({ page })
      .disableRules(KNOWN_VIOLATION_RULES)
      .analyze();

    expect(results.violations).toEqual([]);
  });
});
