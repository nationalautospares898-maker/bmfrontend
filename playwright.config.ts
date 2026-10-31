/**
 * Playwright configuration.
 *
 * Chromium only, deliberately. The counter machines run Chrome or Edge, print fidelity
 * is only verified there (go-live gate OD-6/M27), and a suite that pretends to cover
 * Firefox print output would be claiming evidence nobody has.
 *
 * `BM_E2E_API_URL` points the built app at a real backend. Without it the suite runs the
 * cases that need no server — the offline boundary, the keyboard flow against a stubbed
 * API — and **skips** the ones that do rather than passing vacuously.
 */

import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;

export default defineConfig({
  testDir: './tests/e2e',
  // One worker: the specs share one IndexedDB origin, and a parallel run would have two
  // browsers fighting over the same draft store — which is a real scenario, but it is
  // FE-E-2's owner-tab election, not something to discover by accident here.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  // `github` on CI emits `::error` annotations carrying the actual assertion text, so a
  // failure is diagnosable from the run summary alone. Without it a failing job reports
  // only "Process completed with exit code 1", and the HTML report needs credentials to
  // download — which is how a red run stays a mystery.
  reporter: process.env.CI
    ? [['github'], ['list'], ['html', { open: 'never' }]]
    : [['list']],

  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // A counter monitor, not a phone. The layout is built for this.
    viewport: { width: 1366, height: 768 },
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  // The **built** app, not the dev server: the service worker, the chunking and the
  // print stylesheet all behave differently under Vite's dev transform, and those are
  // exactly the things the E2E suite is for.
  webServer: {
    command: `npm run build && npx vite preview --port ${PORT} --strictPort`,
    port: PORT,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    // `VITE_API_BASE_URL` is read at **build** time (`src/api/client.ts`), so it has to
    // be set for the build rather than for the browser. When `BM_E2E_API_URL` is
    // present the bundle talks to that real backend; when it is absent the default
    // `/api/v1` keeps the stubbed suites working exactly as before.
    env: process.env.BM_E2E_API_URL
      ? { VITE_API_BASE_URL: `${process.env.BM_E2E_API_URL.replace(/\/$/, '')}/api/v1` }
      : {},
  },
});
