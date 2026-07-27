import { defineConfig, devices } from '@playwright/test';

/**
 * AxloPOS end-to-end suite. Test IDs in spec titles map 1:1 to testcases.md.
 *
 * Environment:
 *   E2E_BASE_URL  web app  (default http://localhost:3000)
 *   E2E_API_URL   API base (default http://localhost:4000/v1)
 *   E2E_PROVISION set to 1 to enable tenant-provisioning script cases (ADM-001…)
 *
 * Tags:
 *   @quickbooks — requires a live QuickBooks sandbox connection (skipped
 *                 automatically when the tenant is disconnected)
 *   @db         — needs direct database access (podman psql); skipped if absent
 */
export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 4,
  retries: 0,
  reporter: [
    ['list'],
    ['html', { open: 'never' }],
    ['json', { outputFile: 'test-results/results.json' }],
  ],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000',
    channel: 'chrome',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    navigationTimeout: 30_000,
    actionTimeout: 15_000,
  },
  projects: [
    {
      name: 'setup',
      testMatch: /setup\/.*\.setup\.ts/,
    },
    {
      name: 'chromium',
      testMatch: /tests\/.*\.spec\.ts/,
      dependencies: ['setup'],
      use: { ...devices['Desktop Chrome'], channel: 'chrome', viewport: { width: 1440, height: 900 } },
    },
  ],
});
