import { defineConfig, devices } from '@playwright/test';

// Tests run against local wrangler dev server (localhost:8788)
const baseURL = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:8788';
const isCI = !!process.env.CI;

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  workers: isCI ? 4 : undefined, // Mock data used for all tests
  reporter: 'html',
  timeout: 60000, // 1 minute default, tests can override if needed
  
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

  // Start local wrangler dev server for tests
  ...(baseURL.includes('localhost') ? {
    webServer: {
      command: 'npx wrangler dev --port 8788',
      url: 'http://localhost:8788',
      reuseExistingServer: !isCI,
      timeout: 120000,
    },
  } : {}),
});
