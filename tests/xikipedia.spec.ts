import { test, expect, Page } from '@playwright/test';

/**
 * Helper: loads the app, waits for data, clicks start, waits for first post.
 * Re-used across feature tests that need the feed running.
 */
async function startFeed(page: Page) {
  await page.goto('/');
  const startBtn = page.locator('[data-testid="start-button"]');
  await expect(startBtn).not.toBeDisabled({ timeout: 150000 });
  await startBtn.click();
  await expect(page.locator('#startScreen')).not.toBeVisible({ timeout: 5000 });
  await expect(page.locator('[data-testid="post"]').first()).toBeVisible({ timeout: 10000 });
}

test.describe('Xikipedia', () => {
  test('loads the start screen', async ({ page }) => {
    await page.goto('/');
    
    // Start screen should be visible
    const startScreen = page.locator('#startScreen');
    await expect(startScreen).toBeVisible();
    
    // Title should be present
    await expect(page.locator('h1')).toContainText('Xikipedia');
  });

  test('shows loading state initially', async ({ page }) => {
    await page.goto('/');
    
    // Start button should be disabled during loading
    const startBtn = page.locator('[data-testid="start-button"]');
    
    // Initially it says loading
    await expect(startBtn).toContainText(/loading/i);
  });

  test('displays category pickers', async ({ page }) => {
    await page.goto('/');
    
    // Wait for category pickers to appear
    const categoryPickers = page.locator('.categoryPicker');
    await expect(categoryPickers.first()).toBeVisible({ timeout: 10000 });
    
    // Should have default categories
    const pickerCount = await categoryPickers.count();
    expect(pickerCount).toBeGreaterThanOrEqual(10);
  });

  test('enables start button after data loads', async ({ page }) => {
    test.setTimeout(180000); // 3 minutes for data to load
    
    await page.goto('/');
    
    const startBtn = page.locator('[data-testid="start-button"]');
    
    // Wait for button to become enabled (data loaded)
    await expect(startBtn).not.toBeDisabled({ timeout: 150000 });
    await expect(startBtn).toContainText(/continue/i);
  });

  test('can select categories', async ({ page }) => {
    await page.goto('/');
    
    // Wait for category pickers to appear
    const firstPicker = page.locator('.categoryPicker').first();
    await expect(firstPicker).toBeVisible({ timeout: 10000 });
    
    // Click on a category
    await firstPicker.click();
    
    // Verify it's checked
    const checkbox = firstPicker.locator('input[type="checkbox"]');
    await expect(checkbox).toBeChecked();
  });

  test('starts the feed when clicking continue', async ({ page }) => {
    test.setTimeout(180000); // 3 minutes for data to load
    
    await page.goto('/');
    
    const startBtn = page.locator('[data-testid="start-button"]');
    
    // Wait for button to become enabled
    await expect(startBtn).not.toBeDisabled({ timeout: 150000 });
    
    // Click continue
    await startBtn.click();
    
    // Start screen should be hidden/removed
    await expect(page.locator('#startScreen')).not.toBeVisible({ timeout: 5000 });
    
    // Posts should start appearing
    const posts = page.locator('[data-testid="post"]');
    await expect(posts.first()).toBeVisible({ timeout: 10000 });
  });

  test('can like a post', async ({ page }) => {
    test.setTimeout(180000);
    
    await page.goto('/');
    
    const startBtn = page.locator('[data-testid="start-button"]');
    await expect(startBtn).not.toBeDisabled({ timeout: 150000 });
    await startBtn.click();
    
    // Wait for posts
    const likeButton = page.locator('[data-testid="like-button"]').first();
    await expect(likeButton).toBeVisible({ timeout: 10000 });
    
    // Click like
    await likeButton.click();
    
    // Verify it's liked
    await expect(likeButton).toHaveAttribute('data-liked', 'true');
  });

  test('shows stats sidebar on desktop', async ({ page }) => {
    test.setTimeout(180000);
    
    // Set desktop viewport
    await page.setViewportSize({ width: 1200, height: 800 });
    await page.goto('/');
    
    const startBtn = page.locator('[data-testid="start-button"]');
    await expect(startBtn).not.toBeDisabled({ timeout: 150000 });
    await startBtn.click();
    
    // Stats should be visible
    const stats = page.locator('[data-testid="stats"]');
    await expect(stats).toBeVisible({ timeout: 10000 });
  });

  test('infinite scroll loads more posts', async ({ page }) => {
    test.setTimeout(180000);
    
    await page.goto('/');
    
    const startBtn = page.locator('[data-testid="start-button"]');
    await expect(startBtn).not.toBeDisabled({ timeout: 150000 });
    await startBtn.click();
    
    // Wait for initial posts
    const posts = page.locator('[data-testid="post"]');
    await expect(posts.first()).toBeVisible({ timeout: 10000 });
    
    const initialCount = await posts.count();
    
    // Scroll down
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1000);
    
    // Should have more posts
    const newCount = await posts.count();
    expect(newCount).toBeGreaterThan(initialCount);
  });

  test('category search is enabled after load', async ({ page }) => {
    test.setTimeout(180000);
    
    await page.goto('/');
    
    const searchInput = page.locator('[data-testid="category-search-input"]');
    
    // Initially disabled
    await expect(searchInput).toBeDisabled();
    
    // Wait for data to load
    const startBtn = page.locator('[data-testid="start-button"]');
    await expect(startBtn).not.toBeDisabled({ timeout: 150000 });
    
    // Now search should be enabled
    await expect(searchInput).not.toBeDisabled();
  });
});

// =============================================
// Feature 1: Post-level feedback buttons
// =============================================
test.describe('Feature 1: More/Less feedback buttons', () => {
  test('each post has More and Less feedback buttons', async ({ page }) => {
    test.setTimeout(180000);
    await startFeed(page);

    const firstPost = page.locator('[data-testid="post"]').first();
    const moreBtn = firstPost.locator('.more-btn');
    const lessBtn = firstPost.locator('.less-btn');

    await expect(moreBtn).toBeVisible();
    await expect(lessBtn).toBeVisible();
    await expect(moreBtn).toHaveText('More like this');
    await expect(lessBtn).toHaveText('Less like this');
  });

  test('More button shows Got it animation on click', async ({ page }) => {
    test.setTimeout(180000);
    await startFeed(page);

    const firstPost = page.locator('[data-testid="post"]').first();
    const moreBtn = firstPost.locator('.more-btn');

    await moreBtn.click();

    // "Got it" span should appear
    const gotIt = moreBtn.locator('.got-it');
    await expect(gotIt).toBeAttached();
    await expect(gotIt).toHaveText('Got it');
  });

  test('Less button shows Got it animation on click', async ({ page }) => {
    test.setTimeout(180000);
    await startFeed(page);

    const firstPost = page.locator('[data-testid="post"]').first();
    const lessBtn = firstPost.locator('.less-btn');

    await lessBtn.click();

    const gotIt = lessBtn.locator('.got-it');
    await expect(gotIt).toBeAttached();
    await expect(gotIt).toHaveText('Got it');
  });

  test('feedback buttons do not trigger post click (open Wikipedia)', async ({ page }) => {
    test.setTimeout(180000);
    await startFeed(page);

    // Listen for new tabs/popups (would indicate Wikipedia opened)
    let popupOpened = false;
    page.on('popup', () => { popupOpened = true; });

    const firstPost = page.locator('[data-testid="post"]').first();
    const moreBtn = firstPost.locator('.more-btn');

    await moreBtn.click();
    await page.waitForTimeout(500); // Wait for potential delayed navigation

    expect(popupOpened).toBe(false);
  });

  test('more/less buttons have proper aria-labels', async ({ page }) => {
    test.setTimeout(180000);
    await startFeed(page);

    const firstPost = page.locator('[data-testid="post"]').first();
    const moreBtn = firstPost.locator('.more-btn');
    const lessBtn = firstPost.locator('.less-btn');

    const moreLabel = await moreBtn.getAttribute('aria-label');
    const lessLabel = await lessBtn.getAttribute('aria-label');

    expect(moreLabel).toContain('More like this:');
    expect(lessLabel).toContain('Less like this:');

    // The label should include the article title
    const postTitle = await firstPost.locator('h1').textContent();
    expect(moreLabel).toContain(postTitle!);
    expect(lessLabel).toContain(postTitle!);
  });

  test('feedback buttons disable after click to prevent spam', async ({ page }) => {
    test.setTimeout(180000);
    await startFeed(page);

    const firstPost = page.locator('[data-testid="post"]').first();
    const moreBtn = firstPost.locator('.more-btn');

    await moreBtn.click();
    await page.waitForTimeout(100);

    // Button should be disabled after first click
    await expect(moreBtn).toBeDisabled();
  });
});
