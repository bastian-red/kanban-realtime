import { defineConfig, devices } from '@playwright/test';

/**
 * The E2E lane.
 *
 * **There is no `webServer` block, deliberately.** `scripts/e2e.sh` owns the
 * lifecycle: it migrates, builds in production mode, reseeds, and starts all
 * three processes -- api, realtime gateway and web -- before Playwright is
 * invoked. Letting this config start them instead would mean two different ways
 * to bring the stack up, one of them missing the reseed, and the suite would then
 * pass or fail depending on which one a developer happened to use. Run the lane
 * with `./scripts/e2e.sh`, never with `playwright test` alone.
 *
 * **Two browsers, not one.** Chromium and Firefox. The specs lean on drag and
 * drop, `dialog`-free inline forms, a WebSocket that has to survive a reload, and
 * `prefers-color-scheme` emulation, and those are exactly the surfaces where two
 * engines disagree. Nothing here is WebKit-specific enough to justify a third
 * install on every CI run.
 *
 * **Workers are 1.** Every spec drives the same seeded boards, and this suite
 * opens *two browser contexts at once* to prove a broadcast: a second worker
 * moving a card while another asserts on a column is a flake that reproduces once
 * a fortnight. The suite is small enough that serial execution costs less than
 * the debugging would.
 *
 * `timezoneId: 'UTC'` is pinned for a reason specific to this app: the board
 * computes "overdue" from the *user's stored* zone (`sessionUser.timeZone`), not
 * from the browser's. Ana is `Europe/Madrid` in the seed, so a spec that passes
 * only because the browser agreed with the database is not testing anything.
 */
const WEB_PORT = process.env.WEB_PORT ?? '3000';
const API_PORT = process.env.API_PORT ?? '4000';

export default defineConfig({
  testDir: './tests',
  // `demo.spec.ts` is a capture, not a check: it writes PNGs into
  // `e2e/demo-shots/` and holds still for animations, neither of which belongs in
  // the lane that runs on every push. `scripts/demo-gif.sh` sets DEMO=1 to turn it
  // on. Nothing else in the suite is ever skipped.
  testIgnore: process.env.DEMO === '1' ? [] : ['**/demo.spec.ts'],
  // Failing the run on a stray `test.only` that reached a branch, rather than
  // silently running one test and reporting green.
  forbidOnly: Boolean(process.env.CI),
  fullyParallel: false,
  workers: 1,
  // One retry on CI and none locally. A retry hides a flake locally, where it
  // should be fixed; on a shared runner it absorbs cold-start jitter that has
  // nothing to do with the code, and the trace from the first attempt is still
  // attached.
  retries: process.env.CI ? 1 : 0,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI
    ? [['github'], ['html', { open: 'never' }], ['json']]
    : [['list'], ['html', { open: 'never' }], ['json']],
  outputDir: './test-results',

  use: {
    baseURL: process.env.APP_BASE_URL ?? `http://localhost:${WEB_PORT}`,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    locale: 'en-US',
    timezoneId: 'UTC',
  },

  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
  ],
});

/** Where the API lives, for specs using the `request` fixture directly. */
export const apiBaseUrl = process.env.API_BASE_URL ?? `http://localhost:${API_PORT}`;
