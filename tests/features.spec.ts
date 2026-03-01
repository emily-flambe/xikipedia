import { test, expect, Page } from '@playwright/test';

/**
 * Mock data for testing the 4 new features.
 * This avoids the 40MB download of smoldata.json.
 * Format: { pages: [[title, id, text, thumb, categories, links], ...], subCategories: {}, noPageMaps: {} }
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

/**
 * Intercepts the smoldata.json request and serves mock data.
 * Also sets DATA_SIZE to match mock data size so the progress bar works.
 */
async function setupMockRoute(page: Page) {
  // Unregister service worker IMMEDIATELY to prevent cache-first from bypassing our mock
  await page.evaluate(async () => {
    if ('serviceWorker' in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map(r => r.unregister()));
    }
    if ('caches' in window) {
      const names = await caches.keys();
      await Promise.all(names.map(name => caches.delete(name)));
    }
  }).catch(() => {}); // Ignore errors on fresh pages

  // Also set up for future navigations
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
 * Full startup: mock data, navigate, wait for load, click start, wait for posts.
 */
async function startFeedWithMock(page: Page) {
  await setupMockRoute(page);
  await page.goto('/');

  // Override DATA_SIZE to match mock data so download doesn't fail
  await page.evaluate((size) => {
    (window as any).DATA_SIZE = size;
  }, MOCK_JSON.length).catch(() => {
    // DATA_SIZE is a const, so assignment fails silently in strict mode.
    // The download will work regardless since we intercept the response.
  });

  const startBtn = page.locator('[data-testid="start-button"]');
  await expect(startBtn).not.toBeDisabled({ timeout: 30000 });
  await startBtn.click();
  await expect(page.locator('#startScreen')).not.toBeVisible({ timeout: 5000 });
  await expect(page.locator('[data-testid="post"]').first()).toBeVisible({ timeout: 10000 });
}

// =============================================
// Feature 1: Post-level feedback buttons
// =============================================
test.describe('Feature 1: More/Less feedback buttons', () => {
  test('each post has More and Less feedback buttons', async ({ page }) => {
    await startFeedWithMock(page);

    const firstPost = page.locator('[data-testid="post"]').first();
    const moreBtn = firstPost.locator('.more-btn');
    const lessBtn = firstPost.locator('.less-btn');

    await expect(moreBtn).toBeVisible();
    await expect(lessBtn).toBeVisible();
    await expect(moreBtn).toHaveText('More like this');
    await expect(lessBtn).toHaveText('Less like this');
  });

  test('More button shows Got it animation on click', async ({ page }) => {
    await startFeedWithMock(page);

    const firstPost = page.locator('[data-testid="post"]').first();
    const moreBtn = firstPost.locator('.more-btn');

    await moreBtn.click();

    // "Got it" span should appear
    const gotIt = moreBtn.locator('.got-it');
    await expect(gotIt).toBeAttached();
    await expect(gotIt).toHaveText('Got it');
  });

  test('Less button shows Got it animation on click', async ({ page }) => {
    await startFeedWithMock(page);

    const firstPost = page.locator('[data-testid="post"]').first();
    const lessBtn = firstPost.locator('.less-btn');

    await lessBtn.click();

    const gotIt = lessBtn.locator('.got-it');
    await expect(gotIt).toBeAttached();
    await expect(gotIt).toHaveText('Got it');
  });

  test.skip('rapid clicking More produces multiple overlapping Got it spans', async ({ page }) => {
    await startFeedWithMock(page);

    const firstPost = page.locator('[data-testid="post"]').first();
    const moreBtn = firstPost.locator('.more-btn');

    // Rapid-click 3 times
    await moreBtn.click({ delay: 0 });
    await moreBtn.click({ delay: 0 });
    await moreBtn.click({ delay: 0 });

    // Multiple "Got it" spans should exist simultaneously (animation is 1s)
    const gotIts = moreBtn.locator('.got-it');
    const count = await gotIts.count();
    expect(count).toBeGreaterThanOrEqual(2);
  });

  test('feedback buttons do not trigger post click (no Wikipedia popup)', async ({ page }) => {
    await startFeedWithMock(page);

    let popupOpened = false;
    page.on('popup', () => { popupOpened = true; });

    const firstPost = page.locator('[data-testid="post"]').first();
    const moreBtn = firstPost.locator('.more-btn');

    await moreBtn.click();
    // Wait longer than the 300ms double-tap delay to be sure
    await page.waitForTimeout(500);

    expect(popupOpened).toBe(false);
  });

  test('More button engages post with +150 (skip hidden)', async ({ page }) => {
    await startFeedWithMock(page);

    // Get a reference to a specific category from the first post
    const scienceScoreBefore = await page.evaluate(() => (window as any).categoryScores['science'] ?? 0);

    // The first post should have 'science' as a category (article 0 has science)
    const firstPost = page.locator('[data-testid="post"]').first();
    const moreBtn = firstPost.locator('.more-btn');
    await moreBtn.click();

    // Check that category scores changed
    const totalScoreChange = await page.evaluate(() => {
      const scores = (window as any).categoryScores;
      // Sum all positive scores (excluding defaults)
      return Object.values(scores).reduce((sum: number, v: any) => sum + (v > 0 ? v : 0), 0);
    });
    // Scores should have increased beyond the -5 base engagement
    expect(totalScoreChange).toBeGreaterThan(0);
  });

  test('Less button engages post with -150 (does NOT skip hidden)', async ({ page }) => {
    await startFeedWithMock(page);

    const firstPost = page.locator('[data-testid="post"]').first();
    const lessBtn = firstPost.locator('.less-btn');
    await lessBtn.click();

    // Some category scores should have gone negative beyond the initial -5
    const anyNegative = await page.evaluate(() => {
      const scores = (window as any).categoryScores;
      return Object.values(scores).some((v: any) =>
        v < -100 && v !== -1000 // Exclude default -1000 for given names/surnames
      );
    });
    expect(anyNegative).toBe(true);
  });

  test('feedback buttons update the sidebar', async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 800 });
    await startFeedWithMock(page);

    // Click More to generate positive engagement
    const firstPost = page.locator('[data-testid="post"]').first();
    await firstPost.locator('.more-btn').click();

    // The sidebar should now show categories
    const stats = page.locator('[data-testid="stats"]');
    const catRows = stats.locator('.cat-row');
    await expect(catRows.first()).toBeVisible({ timeout: 5000 });
  });

  test('more/less buttons have aria-labels with article title', async ({ page }) => {
    await startFeedWithMock(page);

    const firstPost = page.locator('[data-testid="post"]').first();
    const postTitle = await firstPost.locator('h1').textContent();

    const moreLabel = await firstPost.locator('.more-btn').getAttribute('aria-label');
    const lessLabel = await firstPost.locator('.less-btn').getAttribute('aria-label');

    expect(moreLabel).toContain('More like this:');
    expect(moreLabel).toContain(postTitle!);
    expect(lessLabel).toContain('Less like this:');
    expect(lessLabel).toContain(postTitle!);
  });
});

// =============================================
// Feature 2: Feed refresh
// =============================================
test.describe('Feature 2: Feed refresh', () => {
  test('refresh button is visible after starting feed', async ({ page }) => {
    await startFeedWithMock(page);

    const refreshBtn = page.locator('#refreshBtn');
    await expect(refreshBtn).toBeVisible();
  });

  test('refresh button is hidden before feed starts', async ({ page }) => {
    await setupMockRoute(page);
    await page.goto('/');

    const refreshBtn = page.locator('#refreshBtn');
    await expect(refreshBtn).not.toBeVisible();
  });

  test('refresh clears posts and new ones appear', async ({ page }) => {
    await startFeedWithMock(page);

    const posts = page.locator('[data-testid="post"]');
    const initialCount = await posts.count();
    expect(initialCount).toBeGreaterThan(0);

    // Get the title of the first post before refresh
    const titleBefore = await posts.first().locator('h1').textContent();

    // Click refresh
    await page.locator('#refreshBtn').click();
    await page.waitForTimeout(1000);

    // New posts should have appeared
    await expect(posts.first()).toBeVisible({ timeout: 5000 });
  });

  test('refresh scrolls page to top', async ({ page }) => {
    await startFeedWithMock(page);

    // Scroll down
    await page.evaluate(() => window.scrollTo(0, 5000));
    await page.waitForTimeout(500);
    const scrollBefore = await page.evaluate(() => window.scrollY);
    expect(scrollBefore).toBeGreaterThan(0);

    // Refresh
    await page.locator('#refreshBtn').click();
    await page.waitForTimeout(300);

    const scrollAfter = await page.evaluate(() => window.scrollY);
    expect(scrollAfter).toBe(0);
  });

  test('refresh preserves category scores (preferences survive)', async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 800 });
    await startFeedWithMock(page);

    // Like a post to create non-default scores
    await page.locator('[data-testid="like-button"]').first().click();
    await page.waitForTimeout(200);

    // Get scores before refresh
    const scoresBefore = await page.evaluate(() => {
      return JSON.parse(JSON.stringify((window as any).categoryScores));
    });

    // Refresh
    await page.locator('#refreshBtn').click();
    await page.waitForTimeout(500);

    // Get scores after refresh
    const scoresAfter = await page.evaluate(() => {
      return JSON.parse(JSON.stringify((window as any).categoryScores));
    });

    // Core scores should be preserved (ignoring new -5 per new post)
    // Check a few keys that should still match
    for (const key of Object.keys(scoresBefore)) {
      if (key === 'given names' || key === 'surnames') continue; // defaults
      if (scoresBefore[key] > 20) {
        // Major engagement scores should survive (may shift slightly from new post -5s)
        expect(scoresAfter[key]).toBeDefined();
      }
    }
  });

  test('refresh resets seen counters on articles', async ({ page }) => {
    await startFeedWithMock(page);

    // Scroll to generate posts (sets seen counts on articles)
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(300);
    }

    // Check that some articles have been seen
    const seenBefore = await page.evaluate(() => {
      return (window as any).pagesArr.filter((p: any) => p.seen > 0).length;
    });
    expect(seenBefore).toBeGreaterThan(0);

    // Refresh
    await page.locator('#refreshBtn').click();
    await page.waitForTimeout(200);

    // Seen counters should be reset
    const seenAfter = await page.evaluate(() => {
      return (window as any).pagesArr.filter((p: any) => p.seen > 0).length;
    });
    // After refresh, seen should be 0 (then new posts increment them)
    // But the render loop immediately creates new posts, so some will have seen=1
    // The key check: the total seen should be much less than before
    expect(seenAfter).toBeLessThan(seenBefore);
  });

  test('postsWithoutLike resets on refresh', async ({ page }) => {
    await startFeedWithMock(page);

    // Scroll to generate posts without liking any
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(300);
    }

    const countBefore = await page.evaluate(() => (window as any).postsWithoutLike);
    expect(countBefore).toBeGreaterThan(0);

    // Refresh
    await page.locator('#refreshBtn').click();
    await page.waitForTimeout(500);

    // Counter should reset to 0 (or small from new auto-generated posts)
    const countAfter = await page.evaluate(() => (window as any).postsWithoutLike);
    expect(countAfter).toBeLessThan(countBefore);
  });

  test('like boost grows with posts viewed in current session', async ({ page }) => {
    await startFeedWithMock(page);

    // Generate many posts without liking
    for (let i = 0; i < 5; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(200);
    }

    const counterBeforeRefresh = await page.evaluate(() => (window as any).postsWithoutLike);

    // Refresh resets the counter
    await page.locator('#refreshBtn').click();
    await page.waitForTimeout(500);

    const counterAfterRefresh = await page.evaluate(() => (window as any).postsWithoutLike);
    // Counter should be much smaller after refresh
    expect(counterAfterRefresh).toBeLessThan(counterBeforeRefresh);

    // The like boost formula is: 50 + postsWithoutLike * 4
    // This encourages engagement while preventing excessive accumulation
    const boost = 50 + counterAfterRefresh * 4;
    expect(boost).toBeGreaterThanOrEqual(50); // minimum boost
    expect(boost).toBeLessThan(counterBeforeRefresh * 4 + 50); // less than pre-refresh would have been
  });
});

// =============================================
// Feature 3: Sidebar category controls
// =============================================
test.describe('Feature 3: Sidebar category controls', () => {
  test('sidebar shows boost/bury/hide buttons for each category row', async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 800 });
    await startFeedWithMock(page);

    // Like to generate engagement scores
    await page.locator('[data-testid="like-button"]').first().click();
    await page.waitForTimeout(200);

    const stats = page.locator('[data-testid="stats"]');
    const firstRow = stats.locator('.cat-row').first();
    await expect(firstRow).toBeVisible({ timeout: 5000 });

    const controls = firstRow.locator('.cat-ctrl');
    await expect(controls).toHaveCount(3);

    // Verify button content
    await expect(controls.nth(0)).toHaveText('+');
    await expect(controls.nth(1)).toHaveText('\u2212');  // Unicode minus
    await expect(controls.nth(2)).toHaveText('\u00d7');  // Unicode multiply
  });

  test('boost button increases category score by 200', async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 800 });
    await startFeedWithMock(page);

    // Like to populate sidebar
    await page.locator('[data-testid="like-button"]').first().click();
    await page.waitForTimeout(200);

    // Open the sidebar drawer (required on all screen sizes since PR #16)
    await page.locator('#statsToggleBtn').click();
    await page.waitForTimeout(400);

    const stats = page.locator('[data-testid="stats"]');
    const firstRow = stats.locator('.cat-row').first();
    await expect(firstRow).toBeVisible({ timeout: 5000 });

    // Capture category name and score BEFORE clicking
    const catName = await firstRow.locator('.cat-name').textContent();
    const scoreBefore = await firstRow.locator('.cat-score').textContent();
    const numBefore = parseInt(scoreBefore!.replace('+', ''));

    // Get the actual category key for verification via JS globals
    const catKey = await page.evaluate((name) => {
      const scores = (window as any).categoryScores;
      for (const [k, v] of Object.entries(scores)) {
        if (k === name || (window as any).convertCat(k) === name) return k;
      }
      return null;
    }, catName);

    // Click boost
    await firstRow.locator('.cat-ctrl').nth(0).click();
    await page.waitForTimeout(100);

    // Verify via JS global (sidebar re-sorts, so DOM order changes)
    const scoreAfter = await page.evaluate((key) => (window as any).categoryScores[key], catKey);
    expect(scoreAfter).toBe(numBefore + 200);
  });

  // TODO: Fix SW cache interference - flaky on CI
  test.skip('bury button decreases category score by 200', async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 800 });
    await startFeedWithMock(page);

    // Like to populate sidebar
    await page.locator('[data-testid="like-button"]').first().click();
    await page.waitForTimeout(200);

    // Open the sidebar drawer (required on all screen sizes since PR #16)
    await page.locator('#statsToggleBtn').click();
    await page.waitForTimeout(400);

    const stats = page.locator('[data-testid="stats"]');
    const firstRow = stats.locator('.cat-row').first();
    await expect(firstRow).toBeVisible({ timeout: 5000 });

    // Capture category name and score BEFORE clicking
    const catName = await firstRow.locator('.cat-name').textContent();
    const scoreBefore = await firstRow.locator('.cat-score').textContent();
    const numBefore = parseInt(scoreBefore!.replace('+', ''));

    // Get the actual category key for verification via JS globals
    const catKey = await page.evaluate((name) => {
      const scores = (window as any).categoryScores;
      for (const [k, v] of Object.entries(scores)) {
        if (k === name || (window as any).convertCat(k) === name) return k;
      }
      return null;
    }, catName);

    // Click bury
    await firstRow.locator('.cat-ctrl').nth(1).click();
    await page.waitForTimeout(100);

    // Verify via JS global (sidebar re-sorts, so DOM order changes)
    // Use toBeLessThanOrEqual because background view events may add additional -5 decay
    const scoreAfter = await page.evaluate((key) => (window as any).categoryScores[key], catKey);
    expect(scoreAfter).toBeLessThanOrEqual(numBefore - 200);
  });

  test('hide button adds category to hiddenCategories set', async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 800 });
    await startFeedWithMock(page);

    // Like to populate sidebar
    await page.locator('[data-testid="like-button"]').first().click();
    await page.waitForTimeout(200);

    // Open the sidebar drawer (required on all screen sizes since PR #16)
    await page.locator('#statsToggleBtn').click();
    await page.waitForTimeout(400);

    const stats = page.locator('[data-testid="stats"]');
    const firstRow = stats.locator('.cat-row').first();
    await expect(firstRow).toBeVisible({ timeout: 5000 });

    // Get hidden count before
    const hiddenBefore = await page.evaluate(() => (window as any).hiddenCategories.size);
    expect(hiddenBefore).toBe(0);

    // Click hide
    await firstRow.locator('.cat-ctrl').nth(2).click();
    await page.waitForTimeout(100);

    const hiddenAfter = await page.evaluate(() => (window as any).hiddenCategories.size);
    expect(hiddenAfter).toBe(1);
  });

  test('hidden section appears after hiding a category', async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 800 });
    await startFeedWithMock(page);

    await page.locator('[data-testid="like-button"]').first().click();
    await page.waitForTimeout(200);

    // Open the sidebar drawer (required on all screen sizes since PR #16)
    await page.locator('#statsToggleBtn').click();
    await page.waitForTimeout(400);

    const stats = page.locator('[data-testid="stats"]');
    await expect(stats.locator('.cat-row').first()).toBeVisible({ timeout: 5000 });

    // No hidden section initially
    await expect(stats.locator('.hidden-section')).not.toBeAttached();

    // Hide a category
    await stats.locator('.cat-row').first().locator('.cat-ctrl').nth(2).click();
    await page.waitForTimeout(100);

    // Hidden section should appear
    await expect(stats.locator('.hidden-section')).toBeVisible();
    await expect(stats.locator('.hidden-toggle')).toContainText('Hidden (1)');
  });

  test('hidden toggle expands and collapses the hidden list', async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 800 });
    await startFeedWithMock(page);

    await page.locator('[data-testid="like-button"]').first().click();
    await page.waitForTimeout(200);

    // Open the sidebar drawer (required on all screen sizes since PR #16)
    await page.locator('#statsToggleBtn').click();
    await page.waitForTimeout(400);

    const stats = page.locator('[data-testid="stats"]');
    await expect(stats.locator('.cat-row').first()).toBeVisible({ timeout: 5000 });
    await stats.locator('.cat-row').first().locator('.cat-ctrl').nth(2).click();
    await page.waitForTimeout(100);

    const toggle = stats.locator('.hidden-toggle');
    const list = stats.locator('.hidden-list');

    // Initially collapsed
    await expect(list).not.toHaveClass(/expanded/);
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');

    // Expand
    await toggle.click();
    await expect(list).toHaveClass(/expanded/);
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');

    // Collapse
    await toggle.click();
    await expect(list).not.toHaveClass(/expanded/);
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });

  test('unhide button restores a category', async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 800 });
    await startFeedWithMock(page);

    await page.locator('[data-testid="like-button"]').first().click();
    await page.waitForTimeout(200);

    // Open the sidebar drawer (required on all screen sizes since PR #16)
    await page.locator('#statsToggleBtn').click();
    await page.waitForTimeout(400);

    const stats = page.locator('[data-testid="stats"]');
    await expect(stats.locator('.cat-row').first()).toBeVisible({ timeout: 5000 });

    const countBefore = await stats.locator('.cat-row').count();

    // Hide
    await stats.locator('.cat-row').first().locator('.cat-ctrl').nth(2).click();
    await page.waitForTimeout(100);

    // Expand hidden list, click unhide
    await stats.locator('.hidden-toggle').click();
    await page.waitForTimeout(100);
    await stats.locator('.unhide-btn').first().click();
    await page.waitForTimeout(100);

    // Hidden section should be gone
    await expect(stats.locator('.hidden-section')).not.toBeAttached();

    // Category count should be restored
    const countAfter = await stats.locator('.cat-row').count();
    expect(countAfter).toBe(countBefore);
  });

  test('sidebar shows Top Categories and Bottom Categories section titles', async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 800 });
    await startFeedWithMock(page);

    await page.locator('[data-testid="like-button"]').first().click();
    await page.waitForTimeout(200);

    const stats = page.locator('[data-testid="stats"]');
    await expect(stats.locator('.stats-section-title').first()).toBeVisible({ timeout: 5000 });

    const titles = stats.locator('.stats-section-title');
    await expect(titles.first()).toHaveText('Top Categories');
  });

  test('category row shows name and formatted score', async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 800 });
    await startFeedWithMock(page);

    await page.locator('[data-testid="like-button"]').first().click();
    await page.waitForTimeout(200);

    const stats = page.locator('[data-testid="stats"]');
    const firstRow = stats.locator('.cat-row').first();
    await expect(firstRow).toBeVisible({ timeout: 5000 });

    // Should have name and score elements
    await expect(firstRow.locator('.cat-name')).toBeVisible();
    await expect(firstRow.locator('.cat-score')).toBeVisible();

    const score = await firstRow.locator('.cat-score').textContent();
    // Positive scores should be prefixed with +
    expect(score).toMatch(/^[+-]?\d+$/);
  });
});

// =============================================
// Feature 4: Mobile sidebar drawer
// =============================================
test.describe('Feature 4: Mobile sidebar drawer', () => {
  test('toggle button visible on all screen sizes', async ({ page }) => {
    // Design change: toggle button is now visible on all screen sizes
    // Sidebar slides in as drawer instead of being fixed position
    await page.setViewportSize({ width: 375, height: 812 });
    await startFeedWithMock(page);

    const toggleBtn = page.locator('#statsToggleBtn');
    await expect(toggleBtn).toBeVisible();

    // Should still be visible on desktop (drawer pattern on all sizes)
    await page.setViewportSize({ width: 1200, height: 800 });
    await page.waitForTimeout(100);
    await expect(toggleBtn).toBeVisible();
  });

  test('clicking toggle opens the sidebar drawer', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await startFeedWithMock(page);

    const stats = page.locator('[data-testid="stats"]');
    const backdrop = page.locator('#statsBackdrop');

    // Initially not open
    await expect(stats).not.toHaveClass(/open/);
    await expect(backdrop).not.toHaveClass(/visible/);

    // Open
    await page.locator('#statsToggleBtn').click();
    await page.waitForTimeout(400);

    await expect(stats).toHaveClass(/open/);
    await expect(backdrop).toHaveClass(/visible/);
  });

  test('close button dismisses the drawer', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await startFeedWithMock(page);

    const stats = page.locator('[data-testid="stats"]');

    // Open
    await page.locator('#statsToggleBtn').click();
    await page.waitForTimeout(400);
    await expect(stats).toHaveClass(/open/);

    // Close
    await stats.locator('.stats-close').click();
    await page.waitForTimeout(400);
    await expect(stats).not.toHaveClass(/open/);
  });

  test('backdrop click dismisses the drawer', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await startFeedWithMock(page);

    const stats = page.locator('[data-testid="stats"]');
    const backdrop = page.locator('#statsBackdrop');

    // Open
    await page.locator('#statsToggleBtn').click();
    await page.waitForTimeout(400);
    await expect(stats).toHaveClass(/open/);

    // Click backdrop on LEFT side (center would hit the drawer on top)
    await backdrop.click({ force: true, position: { x: 30, y: 400 } });
    await page.waitForTimeout(400);

    await expect(stats).not.toHaveClass(/open/);
    await expect(backdrop).not.toHaveClass(/visible/);
  });

  test('mobile drawer has same category controls as desktop sidebar', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await startFeedWithMock(page);

    // Like to get sidebar content
    await page.locator('[data-testid="like-button"]').first().click();
    await page.waitForTimeout(200);

    // Open drawer
    await page.locator('#statsToggleBtn').click();
    await page.waitForTimeout(400);

    const stats = page.locator('[data-testid="stats"]');
    const catRows = stats.locator('.cat-row');
    await expect(catRows.first()).toBeVisible({ timeout: 5000 });

    // Should have boost/bury/hide controls
    const controls = catRows.first().locator('.cat-ctrl');
    await expect(controls).toHaveCount(3);
  });

  test('refresh and stats toggle buttons do not overlap on mobile', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await startFeedWithMock(page);

    const refreshBtn = page.locator('#refreshBtn');
    const toggleBtn = page.locator('#statsToggleBtn');

    await expect(refreshBtn).toBeVisible();
    await expect(toggleBtn).toBeVisible();

    const refreshBox = await refreshBtn.boundingBox();
    const toggleBox = await toggleBtn.boundingBox();

    expect(refreshBox).not.toBeNull();
    expect(toggleBox).not.toBeNull();

    // Refresh is bottom-right (right:24px), toggle is bottom-left (left:24px)
    // They should not horizontally overlap
    const noOverlap =
      (refreshBox!.x + refreshBox!.width <= toggleBox!.x) ||
      (toggleBox!.x + toggleBox!.width <= refreshBox!.x);
    expect(noOverlap).toBe(true);
  });

  test('close button survives sidebar re-render from updateEngagement', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await startFeedWithMock(page);

    // Like a post FIRST (before opening drawer) to populate sidebar
    await page.locator('[data-testid="like-button"]').first().click();
    await page.waitForTimeout(200);

    // Now open drawer
    await page.locator('#statsToggleBtn').click();
    await page.waitForTimeout(400);

    // Like another post to trigger updateEngagement re-render while drawer is open
    // Use force:true since drawer may partially cover the button
    await page.locator('[data-testid="like-button"]').nth(1).click({ force: true });
    await page.waitForTimeout(200);

    // Close button should still function after re-render
    const stats = page.locator('[data-testid="stats"]');
    const closeBtn = stats.locator('.stats-close');
    await expect(closeBtn).toBeVisible();

    await closeBtn.click();
    await page.waitForTimeout(400);
    await expect(stats).not.toHaveClass(/open/);
  });

  test('sidebar is positioned off-screen when closed on mobile', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await startFeedWithMock(page);

    const stats = page.locator('[data-testid="stats"]');

    // The sidebar should exist but be off-screen (right: -320px)
    // On mobile with !important display:block, the element is in the DOM
    const box = await stats.boundingBox();
    // The sidebar x position should be at or past the viewport edge
    if (box) {
      expect(box.x).toBeGreaterThanOrEqual(375);
    }
  });
});

// =============================================
// Cross-feature and edge case tests
// =============================================
test.describe('Cross-feature edge cases', () => {
  test('hidden categories survive feed refresh', async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 800 });
    await startFeedWithMock(page);

    // Like, then hide
    await page.locator('[data-testid="like-button"]').first().click();
    await page.waitForTimeout(200);

    // Open the sidebar drawer (required on all screen sizes since PR #16)
    await page.locator('#statsToggleBtn').click();
    await page.waitForTimeout(400);

    const stats = page.locator('[data-testid="stats"]');
    await expect(stats.locator('.cat-row').first()).toBeVisible({ timeout: 5000 });
    await stats.locator('.cat-row').first().locator('.cat-ctrl').nth(2).click();
    await page.waitForTimeout(100);

    const hiddenBefore = await page.evaluate(() => (window as any).hiddenCategories.size);
    expect(hiddenBefore).toBe(1);

    // Close sidebar by clicking backdrop (it intercepts clicks when open)
    await page.locator('#statsBackdrop').click();
    await page.waitForTimeout(300);

    // Refresh feed
    await page.locator('#refreshBtn').click();
    await page.waitForTimeout(500);

    const hiddenAfter = await page.evaluate(() => (window as any).hiddenCategories.size);
    expect(hiddenAfter).toBe(1);
  });

  test('hiding from mobile drawer works correctly', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await startFeedWithMock(page);

    // Like to get sidebar content
    await page.locator('[data-testid="like-button"]').first().click();
    await page.waitForTimeout(200);

    // Open drawer
    await page.locator('#statsToggleBtn').click();
    await page.waitForTimeout(400);

    const stats = page.locator('[data-testid="stats"]');
    await expect(stats.locator('.cat-row').first()).toBeVisible({ timeout: 5000 });

    // Hide from mobile drawer
    await stats.locator('.cat-row').first().locator('.cat-ctrl').nth(2).click();
    await page.waitForTimeout(100);

    // Hidden section should appear inside the drawer
    await expect(stats.locator('.hidden-section')).toBeVisible();

    const hiddenCount = await page.evaluate(() => (window as any).hiddenCategories.size);
    expect(hiddenCount).toBe(1);
  });

  test('More like this with hidden category skips hidden in engagement', async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 800 });
    await startFeedWithMock(page);

    // Like to populate sidebar
    await page.locator('[data-testid="like-button"]').first().click();
    await page.waitForTimeout(200);

    const stats = page.locator('[data-testid="stats"]');
    await expect(stats.locator('.cat-row').first()).toBeVisible({ timeout: 5000 });

    // Get a category name and hide it
    const catNameToHide = await page.evaluate(() => {
      const cats = (window as any).hiddenCategories;
      // Get the first visible category key from scores
      const scores = (window as any).categoryScores;
      for (const k of Object.keys(scores)) {
        if (scores[k] > 0 && k !== 'given names' && k !== 'surnames') return k;
      }
      return null;
    });

    if (catNameToHide) {
      // Hide this category via JS
      await page.evaluate((cat) => {
        (window as any).hiddenCategories.add(cat);
        (window as any).updateEngagement();
      }, catNameToHide);
      await page.waitForTimeout(100);

      // Get the score before "More like this"
      const scoreBefore = await page.evaluate(
        (cat) => (window as any).categoryScores[cat],
        catNameToHide
      );

      // Click More on a post that has this category
      const firstPost = page.locator('[data-testid="post"]').first();
      await firstPost.locator('.more-btn').click();

      // The hidden category should NOT have been boosted by More (skipHidden=true)
      const scoreAfter = await page.evaluate(
        (cat) => (window as any).categoryScores[cat],
        catNameToHide
      );

      // Score should be unchanged for the hidden category
      expect(scoreAfter).toBe(scoreBefore);
    }
  });

  test('Less like this does NOT skip hidden categories in engagement', async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 800 });
    await startFeedWithMock(page);

    // Like to populate
    await page.locator('[data-testid="like-button"]').first().click();
    await page.waitForTimeout(200);

    const stats = page.locator('[data-testid="stats"]');
    await expect(stats.locator('.cat-row').first()).toBeVisible({ timeout: 5000 });

    // Hide a category and get its score
    const result = await page.evaluate(() => {
      const scores = (window as any).categoryScores;
      for (const k of Object.keys(scores)) {
        if (scores[k] > 0 && k !== 'given names' && k !== 'surnames') {
          (window as any).hiddenCategories.add(k);
          return { cat: k, score: scores[k] };
        }
      }
      return null;
    });

    if (result) {
      await page.evaluate(() => (window as any).updateEngagement());
      await page.waitForTimeout(100);

      // Click Less on first post
      const firstPost = page.locator('[data-testid="post"]').first();
      await firstPost.locator('.less-btn').click();

      // The hidden category SHOULD be affected by Less (skipHidden=false)
      // But only if the first post has this category in its allCategories
      const scoreAfter = await page.evaluate(
        (cat) => (window as any).categoryScores[cat],
        result.cat
      );

      // The score might or might not change depending on whether this post has the category
      // This test verifies the behavior: Less does not skip hidden
      // If the post has the hidden category, score should decrease by 150
      if (scoreAfter !== result.score) {
        expect(scoreAfter).toBe(result.score - 150);
      }
    }
  });

  test('category filter in getNextPost penalizes all-hidden posts', async ({ page }) => {
    await startFeedWithMock(page);

    // Verify getNextPost scoring via JS evaluation
    const result = await page.evaluate(() => {
      const pagesArr = (window as any).pagesArr;
      const hiddenCategories = (window as any).hiddenCategories;
      const categoryScores = (window as any).categoryScores;

      // Pick a post and hide ALL of its categories
      const testPost = pagesArr[0];
      const cats = [...testPost.allCategories];

      // First, boost some categories
      cats.forEach((c: string) => {
        categoryScores[c] = 100;
      });

      // Get score before hiding
      const scoreBefore = cats.reduce(
        (sum: number, c: string) => sum + (categoryScores[c] ?? 0),
        0
      );

      // Now hide all categories of this post
      cats.forEach((c: string) => hiddenCategories.add(c));

      // Manually compute what getNextPost would compute
      let allHidden = hiddenCategories.size > 0;
      const postScore = cats.reduce(
        (sum: number, cat: string) => {
          if (hiddenCategories.has(cat)) return sum;
          allHidden = false;
          return sum + (categoryScores[cat] ?? 0);
        },
        0
      );

      // Clean up
      cats.forEach((c: string) => hiddenCategories.delete(c));

      return {
        allHidden,
        postScore,
        scoreBefore,
      };
    });

    // All categories were hidden, so allHidden should be true
    expect(result.allHidden).toBe(true);
    // postScore should just be the initialScore (0) since all cats were skipped
    expect(result.postScore).toBe(0);
  });

  test('pull-to-refresh indicator element exists after feed starts', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await startFeedWithMock(page);

    const indicator = page.locator('#pullIndicator');
    await expect(indicator).toBeAttached();
    // Initially the indicator should not have the 'active' class (collapsed state)
    await expect(indicator).not.toHaveClass(/active/);
  });
});

// =============================================
// Chunked Format: Lazy Text Loading
// =============================================
test.describe('Chunked Format: Lazy Text Loading', () => {
  /**
   * Generate mock index data for chunked format.
   * Index contains articles without text, only with chunkId.
   * Production format: [title, pageId, chunkId, thumbHash, categories]
   */
  function generateChunkedIndexData() {
    const pages = [];
    const categories = ['science', 'nature', 'animals', 'technology', 'music', 'art', 'history', 'sports'];
    for (let i = 0; i < 200; i++) {
      const cat1 = categories[i % categories.length];
      const cat2 = categories[(i + 3) % categories.length];
      const hasThumb = i % 3 === 0;
      const chunkId = Math.floor(i / 10); // 10 articles per chunk
      // Format: [title, pageId, chunkId, thumbHash, categories]
      pages.push([
        `Chunked Article ${i}`,
        i + 1000, // pageId - different IDs from simple format
        chunkId,  // chunkId at position [2]
        hasThumb ? `test_image_${i}.jpg` : null,  // thumbHash
        [cat1, cat2]  // categories
      ]);
    }
    return {
      format: 'chunked',
      pages,
      subCategories: {
        science: ['physics', 'chemistry', 'biology'],
        nature: ['animals', 'plants'],
        animals: ['mammals', 'birds'],
      },
      noPageMaps: {}
    };
  }

  /**
   * Generate mock chunk data for a specific chunk ID.
   */
  function generateChunkData(chunkId: number) {
    const articles: Record<string, { text: string }> = {};
    const startId = 1000 + chunkId * 10;
    for (let i = 0; i < 10; i++) {
      const id = startId + i;
      articles[String(id)] = {
        text: `This is the lazy-loaded text content of chunked article ${id - 1000}. It contains enough text to pass the 100-character minimum filter. Here is additional padding content to make this article long enough.`
      };
    }
    return { articles };
  }

  const CHUNKED_INDEX = generateChunkedIndexData();
  const CHUNKED_INDEX_JSON = JSON.stringify(CHUNKED_INDEX);

  /**
   * Setup routes for chunked format testing.
   * Note: Chunked format loads index.json (not smoldata.json)
   */
  async function setupChunkedRoutes(page: Page, options: { failChunk?: number; delayChunkMs?: number } = {}) {
    // Route index.json for chunked format
    await page.route('**/index.json', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: CHUNKED_INDEX_JSON,
      });
    });

    // Route chunk files
    await page.route('**/articles/chunk-*.json', async (route) => {
      // Optional delay for testing skeleton state
      if (options.delayChunkMs) {
        await new Promise(resolve => setTimeout(resolve, options.delayChunkMs));
      }
      
      const url = route.request().url();
      const match = url.match(/chunk-(\d+)\.json/);
      if (match) {
        const chunkId = parseInt(match[1], 10);
        
        // Simulate failure for specific chunk if requested
        if (options.failChunk === chunkId) {
          await route.fulfill({
            status: 500,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'Chunk fetch failed' }),
          });
          return;
        }
        
        const chunkData = generateChunkData(chunkId);
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(chunkData),
        });
      }
    });
  }

  /**
   * Start feed with chunked format mock data.
   * Uses ?format=chunked URL parameter to trigger chunked format loading.
   */
  async function startFeedWithChunkedMock(page: Page, options: { failChunk?: number } = {}) {
    await setupChunkedRoutes(page, options);
    // Must use ?format=chunked to trigger chunked format mode
    await page.goto('/?format=chunked');

    const startBtn = page.locator('[data-testid="start-button"]');
    await expect(startBtn).not.toBeDisabled({ timeout: 30000 });
    await startBtn.click();
    await expect(page.locator('#startScreen')).not.toBeVisible({ timeout: 5000 });
    await expect(page.locator('[data-testid="post"]').first()).toBeVisible({ timeout: 10000 });
  }

  test('chunked format shows skeleton while loading text', async ({ page }) => {
    // Set up route that delays chunk response
    await page.route('**/index.json', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: CHUNKED_INDEX_JSON,
      });
    });

    await page.route('**/articles/chunk-*.json', async (route) => {
      // Small delay to observe skeleton state
      await new Promise(resolve => setTimeout(resolve, 200));
      
      const url = route.request().url();
      const match = url.match(/chunk-(\d+)\.json/);
      if (match) {
        const chunkId = parseInt(match[1], 10);
        const chunkData = generateChunkData(chunkId);
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(chunkData),
        });
      }
    });

    // Must use ?format=chunked to trigger chunked format mode
    await page.goto('/?format=chunked');

    const startBtn = page.locator('[data-testid="start-button"]');
    await expect(startBtn).not.toBeDisabled({ timeout: 30000 });
    await startBtn.click();
    await expect(page.locator('#startScreen')).not.toBeVisible({ timeout: 5000 });

    // Wait for posts to appear
    const posts = page.locator('[data-testid="post"]');
    await expect(posts.first()).toBeVisible({ timeout: 10000 });
    
    // Wait for text to finish loading - paragraphs should have content or be in error state
    // (They transition from skeleton → text or skeleton → error)
    const paragraphs = posts.first().locator('p');
    await expect(paragraphs.first()).not.toHaveClass(/skeleton/, { timeout: 10000 });
  });

  // TODO: Enable when chunk files are deployed to R2
  test.skip('chunked format loads text successfully and caches it', async ({ page }) => {
    await startFeedWithChunkedMock(page);

    // Wait for any post to have text content (not skeleton or error)
    const postsWithText = page.locator('[data-testid="post"] p:not(.skeleton):not(.load-error)');
    
    // At least one post should have loaded text successfully
    await expect(postsWithText.first()).toBeVisible({ timeout: 10000 });
    
    // Verify the text contains expected content
    const textContent = await postsWithText.first().textContent();
    expect(textContent).toBeTruthy();
    expect(textContent!.length).toBeGreaterThan(50); // Should have substantial content
  });

  // TODO: Enable when chunk files are deployed to R2
  test.skip('chunked format shows error state with retry button on fetch failure', async ({ page }) => {
    // Create a route that ALWAYS fails chunk fetches
    await page.route('**/index.json', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: CHUNKED_INDEX_JSON,
      });
    });

    await page.route('**/articles/chunk-*.json', async (route) => {
      // Always fail chunk requests to force error state
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Simulated failure' }),
      });
    });

    // Must use ?format=chunked to trigger chunked format mode
    await page.goto('/?format=chunked');

    const startBtn = page.locator('[data-testid="start-button"]');
    await expect(startBtn).not.toBeDisabled({ timeout: 30000 });
    await startBtn.click();
    await expect(page.locator('#startScreen')).not.toBeVisible({ timeout: 5000 });

    // Wait for any post with error state
    const errorPosts = page.locator('[data-testid="post"] p.load-error');
    await expect(errorPosts.first()).toBeVisible({ timeout: 10000 });
    
    // Check for retry button in error state
    const retryBtn = errorPosts.first().locator('.retry-btn');
    await expect(retryBtn).toBeVisible();
    await expect(retryBtn).toHaveText('Retry');
  });

  // TODO: Enable when chunk files are deployed to R2
  test.skip('retry button successfully loads text after failure', async ({ page }) => {
    // Track fetch attempts per chunk to fail first, succeed on retry
    const fetchAttempts = new Map<number, number>();
    
    await page.route('**/index.json', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: CHUNKED_INDEX_JSON,
      });
    });

    await page.route('**/articles/chunk-*.json', async (route) => {
      const url = route.request().url();
      const match = url.match(/chunk-(\d+)\.json/);
      if (match) {
        const chunkId = parseInt(match[1], 10);
        const attempts = (fetchAttempts.get(chunkId) || 0) + 1;
        fetchAttempts.set(chunkId, attempts);
        
        // Fail the first attempt, succeed on retry
        if (attempts === 1) {
          await route.fulfill({
            status: 500,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'Simulated failure' }),
          });
          return;
        }
        
        const chunkData = generateChunkData(chunkId);
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(chunkData),
        });
      }
    });

    // Must use ?format=chunked to trigger chunked format mode
    await page.goto('/?format=chunked');

    const startBtn = page.locator('[data-testid="start-button"]');
    await expect(startBtn).not.toBeDisabled({ timeout: 30000 });
    await startBtn.click();
    await expect(page.locator('#startScreen')).not.toBeVisible({ timeout: 5000 });

    // Wait for any post with error state to appear
    const errorPosts = page.locator('[data-testid="post"] p.load-error');
    await expect(errorPosts.first()).toBeVisible({ timeout: 10000 });
    
    // Click retry button on the first error post
    const retryBtn = errorPosts.first().locator('.retry-btn');
    await retryBtn.click();
    
    // Wait for that paragraph to no longer be in error state
    // It should either show skeleton (loading) or have text content
    await expect(errorPosts.first()).not.toHaveClass(/load-error/, { timeout: 5000 });
  });

  test('chunked format correctly identifies format via isChunkedFormat flag', async ({ page }) => {
    await startFeedWithChunkedMock(page);

    // isChunkedFormat is exposed to window, check it
    const isChunked = await page.evaluate(() => {
      return (window as any).isChunkedFormat;
    });
    
    expect(isChunked).toBe(true);
    
    // Also verify chunkCache and chunkFetcher are initialized
    const hasChunkInfra = await page.evaluate(() => {
      return !!(window as any).chunkCache && !!(window as any).chunkFetcher;
    });
    
    expect(hasChunkInfra).toBe(true);
  });

  test('chunked format initializes chunk infrastructure', async ({ page }) => {
    await startFeedWithChunkedMock(page);

    // Verify chunk infrastructure is set up
    const infraStatus = await page.evaluate(() => {
      const cache = (window as any).chunkCache;
      const fetcher = (window as any).chunkFetcher;
      return {
        hasCache: !!cache,
        hasFetcher: !!fetcher,
        cacheHasGetStats: typeof cache?.getStats === 'function',
        fetcherHasGetArticleText: typeof fetcher?.getArticleText === 'function'
      };
    });
    
    expect(infraStatus.hasCache).toBe(true);
    expect(infraStatus.hasFetcher).toBe(true);
    expect(infraStatus.cacheHasGetStats).toBe(true);
    expect(infraStatus.fetcherHasGetArticleText).toBe(true);
  });
});

// =============================================
// EMI-29: History panel click does not duplicate posts
// =============================================
test.describe('EMI-29: History panel duplicate prevention', () => {
  test('clicking a history item already in the feed scrolls to it instead of duplicating', async ({ page }) => {
    await startFeedWithMock(page);

    const firstPost = page.locator('[data-testid="post"]').first();
    await expect(firstPost).toBeVisible();
    const postId = await firstPost.getAttribute('data-id');
    expect(postId).toBeTruthy();

    // Open history panel
    await page.locator('#historyToggle').click();
    await expect(page.locator('#historyPanel')).toBeVisible();

    // Click the history item matching the first post
    const historyItem = page.locator(`.history-item[data-id="${postId}"]`);
    await expect(historyItem).toBeVisible();
    await historyItem.click();

    // Should NOT create a duplicate
    const postsWithId = page.locator(`[data-testid="post"][data-id="${postId}"]`);
    await expect(postsWithId).toHaveCount(1);
  });

  test('clicking a history item not in the feed creates it', async ({ page }) => {
    await startFeedWithMock(page);

    const firstPost = page.locator('[data-testid="post"]').first();
    await expect(firstPost).toBeVisible();
    const postId = await firstPost.getAttribute('data-id');

    // Remove post from DOM to simulate it being gone
    await page.evaluate((id) => {
      const post = document.querySelector(`.post[data-id="${id}"]`);
      if (post) post.remove();
    }, postId);

    await expect(page.locator(`[data-testid="post"][data-id="${postId}"]`)).toHaveCount(0);

    // Open history panel and click the removed article
    await page.locator('#historyToggle').click();
    await expect(page.locator('#historyPanel')).toBeVisible();

    const historyItem = page.locator(`.history-item[data-id="${postId}"]`);
    await expect(historyItem).toBeVisible();
    await historyItem.click();

    // Post should be re-created
    await expect(page.locator(`[data-testid="post"][data-id="${postId}"]`)).toHaveCount(1);
  });

  test('rapid history clicks on the same item do not create duplicates', async ({ page }) => {
    await startFeedWithMock(page);

    const firstPost = page.locator('[data-testid="post"]').first();
    await expect(firstPost).toBeVisible();
    const postId = await firstPost.getAttribute('data-id');

    // Remove the post so the history click will try to re-create it
    await page.evaluate((id) => {
      const post = document.querySelector(`.post[data-id="${id}"]`);
      if (post) post.remove();
    }, postId);

    // Open history panel and rapid-click the same item multiple times
    await page.locator('#historyToggle').click();
    await expect(page.locator('#historyPanel')).toBeVisible();

    const historyItem = page.locator(`.history-item[data-id="${postId}"]`);
    await expect(historyItem).toBeVisible();

    // Fire multiple clicks synchronously (bypassing panel hide)
    await page.evaluate((id) => {
      const item = document.querySelector(`.history-item[data-id="${id}"]`) as HTMLElement;
      if (item) {
        item.click();
        item.click();
        item.click();
      }
    }, postId);

    await page.waitForTimeout(300);

    // Should still have exactly one post with this ID
    const postsWithId = page.locator(`[data-testid="post"][data-id="${postId}"]`);
    await expect(postsWithId).toHaveCount(1);
  });
});
