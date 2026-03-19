import { defineConfig, devices } from '@playwright/test';

// Tests run against local wrangler dev server by default (localhost:8799).
// Override with PLAYWRIGHT_BASE_URL env var for production testing.
// Note: window.__xikiTest is only created when hostname === 'localhost',
// so tests using startFeedWithMock() only work on localhost.
const baseURL = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:8801';
const isCI = !!process.env.CI;
const isLocalhost = baseURL.includes('localhost');

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

  // Only start local dev server when testing against localhost
  webServer: isLocalhost ? {
    command: 'npx wrangler dev --port 8801',
    port: 8801,
    reuseExistingServer: !isCI,
    timeout: 120000,
  } : undefined,
});
