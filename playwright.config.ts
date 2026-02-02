import { defineConfig, devices } from '@playwright/test';

// In CI, test against production; locally, use dev server
const baseURL = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:8788';
const isCI = !!process.env.CI;

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  workers: isCI ? 1 : undefined,
  reporter: 'html',
  timeout: 180000, // 3 minutes - data loading is slow
  
  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  // Only start local server when not testing against production
  ...(baseURL.includes('localhost') ? {
    webServer: {
      command: 'npx wrangler dev --port 8788',
      url: 'http://localhost:8788',
      reuseExistingServer: !isCI,
      timeout: 120000,
    },
  } : {}),
});
