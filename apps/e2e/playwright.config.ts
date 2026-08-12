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
      // Tablet specs opt into the two tablet-* projects declared below;
      // the desktop project must skip them so a landscape-only assertion
      // does not run twice against the same viewport.
      testIgnore: /tests\/tablet-.*\.spec\.ts/,
      dependencies: ['setup'],
      use: { ...devices['Desktop Chrome'], channel: 'chrome', viewport: { width: 1440, height: 900 } },
    },
    /*
     * Tablet viewports for the responsive redesign. Both target the
     * Restaurant journeys that were audited as the primary tablet use
     * cases — waiter (tables → order entry) and counter (POS → payment).
     *
     * Landscape 1194×834 = iPad Pro 11" — the "big" landscape iPad.
     * Portrait  834×1194 — the same device rotated. iPad Air / 10.9" fall
     * in the same band (1180×820 / 820×1180) — the layout at 900px+ (the
     * `tab:` breakpoint) is stable across all of them, so testing one
     * point in each band is sufficient. Adding one more spec at 768×1024
     * (iPad Mini portrait, below tab:) would prove the drawer + sticky
     * bar behaviour on the narrow-tablet band; skipped for this pass to
     * keep CI parallelism reasonable — the render tests already cover
     * the `<tab:` branches.
     *
     * Both projects run ONLY the tablet-flagged specs (`tablet-*.spec.ts`)
     * to keep default `pnpm test:e2e` fast; the desktop `chromium`
     * project continues to run everything else.
     */
    {
      name: 'tablet-landscape',
      testMatch: /tests\/tablet-.*\.spec\.ts/,
      dependencies: ['setup'],
      use: {
        ...devices['Desktop Chrome'],
        channel: 'chrome',
        viewport: { width: 1194, height: 834 },
        hasTouch: true,
        isMobile: false,
      },
    },
    {
      name: 'tablet-portrait',
      testMatch: /tests\/tablet-.*\.spec\.ts/,
      dependencies: ['setup'],
      use: {
        ...devices['Desktop Chrome'],
        channel: 'chrome',
        viewport: { width: 834, height: 1194 },
        hasTouch: true,
        isMobile: false,
      },
    },
  ],
});
