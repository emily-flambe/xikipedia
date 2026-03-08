import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:8788';
const isCI = !!process.env.CI;
const isLocalhost = baseURL.includes('localhost');

export default defineConfig({
  testDir: './tests',
  testMatch: '**/rate-limiting.spec.ts',
  // Serial execution required: login and register rate limit keys are shared
  // across all requests in dev (all requests use IP 'unknown').
  fullyParallel: false,
  workers: 1,
  forbidOnly: isCI,
  retries: 0,
  reporter: 'line',
  timeout: 60000,

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

  webServer: isLocalhost ? {
    command: 'npx wrangler dev --port 8788',
    port: 8788,
    reuseExistingServer: !isCI,
    timeout: 120000,
  } : undefined,
});
