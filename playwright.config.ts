import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright E2E Test Configuration
 *
 * This configuration sets up E2E tests for the Al Ummah Now Auth system.
 * Tests run against local wrangler dev servers for all three apps.
 *
 * Prerequisites:
 * - All apps running in dev mode: pnpm dev
 * - Auth server: http://localhost:8787
 * - Admin dashboard: http://localhost:5175
 * - Profile app: http://localhost:8788
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: ['**/*.spec.ts'],

  // Test execution settings
  timeout: 30 * 1000, // 30 seconds per test
  expect: {
    timeout: 5000, // 5 seconds for assertions
  },

  // Run tests in files in parallel
  fullyParallel: true,

  // Fail the build on CI if you accidentally left test.only in the source code
  forbidOnly: !!process.env.CI,

  // Retry on CI only
  retries: process.env.CI ? 2 : 0,

  // Parallel workers
  // Reduced from 4 to 2 to mitigate SQLITE_BUSY errors from database contention
  workers: process.env.CI ? 1 : 2,

  // Reporter to use
  reporter: [
    ['html', { outputFolder: 'e2e-report', open: 'never' }],
    ['json', { outputFile: 'e2e-results.json' }],
    ['junit', { outputFile: 'e2e-results.xml' }],
    ['list'], // Console reporter
  ],

  // Shared settings for all projects
  use: {
    // Base URL for navigation
    baseURL: 'http://localhost:8788', // Profile app is the main entry point

    // Collect trace on failure
    trace: 'on-first-retry',

    // Screenshot on failure
    screenshot: 'only-on-failure',

    // Video on failure
    video: 'retain-on-failure',

    // Maximum time each action can take
    actionTimeout: 10000,

    // Browser context options
    viewport: { width: 1280, height: 720 },
    ignoreHTTPSErrors: true,

    // Emulate browser locale and timezone
    locale: 'en-US',
    timezoneId: 'America/New_York',
  },

  // Configure projects for major browsers
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },

    // Uncomment to test on other browsers
    // {
    //   name: 'firefox',
    //   use: { ...devices['Desktop Firefox'] },
    // },
    // {
    //   name: 'webkit',
    //   use: { ...devices['Desktop Safari'] },
    // },

    // Mobile viewports
    // {
    //   name: 'Mobile Chrome',
    //   use: { ...devices['Pixel 5'] },
    // },
    // {
    //   name: 'Mobile Safari',
    //   use: { ...devices['iPhone 12'] },
    // },
  ],

  // Run your local dev server before starting the tests
  // This is optional - you can also start services manually
  webServer: process.env.SKIP_WEB_SERVER ? undefined : [
    {
      command: 'cd apps/auth && pnpm dev',
      port: 8787,
      reuseExistingServer: !process.env.CI,
      timeout: 30 * 1000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: 'cd apps/admin && pnpm dev:wrangler',
      port: 5175,
      reuseExistingServer: !process.env.CI,
      timeout: 30 * 1000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: 'cd apps/profile && pnpm dev',
      port: 8788,
      reuseExistingServer: !process.env.CI,
      timeout: 30 * 1000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
});
