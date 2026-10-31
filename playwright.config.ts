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

// Overridable so an acceptance run can use a free port instead of fighting a preview
// server a developer already has open on 4173.
const PORT = Number(process.env.BM_E2E_PORT ?? 4173);

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
    // present the bundle talks to that real backend.
    //
    // `BM_DEV_API_PROXY` is forwarded explicitly rather than left to inheritance,
    // because `vite.config.ts` reads it in the preview process. With it set the bundle
    // is pinned to the **relative** base, so requests go to the page's own origin and
    // satisfy the CSP's `connect-src 'self'` whatever port the API is on — which is how
    // the acceptance suite reaches a throwaway API and database without widening a
    // security control and without disturbing an instance on 8000.
    //
    // That pin is explicit rather than left to the fallback in `client.ts`, because a
    // developer's git-ignored `.env.local` sets `VITE_API_BASE_URL=http://localhost:8000`
    // and Vite bakes it into **every** build, this one included. Relying on the default
    // meant the acceptance build quietly pointed at whatever was on port 8000 — the
    // live shop instance. Inline `VITE_`-prefixed variables take precedence over
    // `.env*` files in Vite, so setting it here is what makes the isolation real; the
    // alternative is a suite that silently tests, or writes to, the wrong database.
    env: {
      ...(process.env.BM_DEV_API_PROXY
        ? { BM_DEV_API_PROXY: process.env.BM_DEV_API_PROXY, VITE_API_BASE_URL: '/api/v1' }
        : process.env.BM_E2E_API_URL
          ? {
              VITE_API_BASE_URL: `${process.env.BM_E2E_API_URL.replace(/\/$/, '')}/api/v1`,
            }
          : {}),
    },
  },
});
