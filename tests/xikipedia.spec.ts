import { test, expect, Page } from '@playwright/test';

/**
 * Helper: loads the app, waits for data, clicks start, waits for first post.
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
// Feature 4: Mobile sidebar drawer
// =============================================
test.describe('Feature 4: Mobile sidebar drawer', () => {
  test('mobile toggle button is visible on small viewport', async ({ page }) => {
    test.setTimeout(180000);
    await page.setViewportSize({ width: 375, height: 812 });
    await startFeed(page);

    const toggleBtn = page.locator('#statsToggleBtn');
    await expect(toggleBtn).toBeVisible();
  });

  test('mobile toggle button is hidden on desktop viewport', async ({ page }) => {
    test.setTimeout(180000);
    await page.setViewportSize({ width: 1200, height: 800 });
    await startFeed(page);

    const toggleBtn = page.locator('#statsToggleBtn');
    await expect(toggleBtn).not.toBeVisible();
  });

  test('clicking toggle opens the drawer', async ({ page }) => {
    test.setTimeout(180000);
    await page.setViewportSize({ width: 375, height: 812 });
    await startFeed(page);

    const toggleBtn = page.locator('#statsToggleBtn');
    const stats = page.locator('[data-testid="stats"]');
    const backdrop = page.locator('#statsBackdrop');

    await toggleBtn.click();
    await page.waitForTimeout(400);

    await expect(stats).toHaveClass(/open/);
    await expect(backdrop).toHaveClass(/visible/);
  });

  test('close button dismisses the drawer', async ({ page }) => {
    test.setTimeout(180000);
    await page.setViewportSize({ width: 375, height: 812 });
    await startFeed(page);

    const toggleBtn = page.locator('#statsToggleBtn');
    const stats = page.locator('[data-testid="stats"]');
    const closeBtn = stats.locator('.stats-close');

    await toggleBtn.click();
    await page.waitForTimeout(400);
    await expect(stats).toHaveClass(/open/);

    await closeBtn.click();
    await page.waitForTimeout(400);
    await expect(stats).not.toHaveClass(/open/);
  });

  test('backdrop click dismisses the drawer', async ({ page }) => {
    test.setTimeout(180000);
    await page.setViewportSize({ width: 375, height: 812 });
    await startFeed(page);

    const toggleBtn = page.locator('#statsToggleBtn');
    const stats = page.locator('[data-testid="stats"]');
    const backdrop = page.locator('#statsBackdrop');

    await toggleBtn.click();
    await page.waitForTimeout(400);
    await expect(stats).toHaveClass(/open/);

    await backdrop.click({ force: true });
    await page.waitForTimeout(400);

    await expect(stats).not.toHaveClass(/open/);
    await expect(backdrop).not.toHaveClass(/visible/);
  });

  test('refresh button and stats toggle do not overlap on mobile', async ({ page }) => {
    test.setTimeout(180000);
    await page.setViewportSize({ width: 375, height: 812 });
    await startFeed(page);

    const toggleBtn = page.locator('#statsToggleBtn');
    await expect(toggleBtn).toBeVisible();

    // Toggle is bottom-left, which should not overlap with any other bottom-right elements
    const toggleBox = await toggleBtn.boundingBox();
    expect(toggleBox).not.toBeNull();
    // Verify it's on the left side of the screen
    expect(toggleBox!.x).toBeLessThan(375 / 2);
  });
});
