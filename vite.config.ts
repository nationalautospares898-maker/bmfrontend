import { fileURLToPath, URL } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

/**
 * Add the configured API origin to the CSP's `connect-src`, at build time.
 *
 * `index.html` declares `connect-src 'self' http://localhost:8000` — a real security
 * control, and the literal is correct for local development. It is also the **only**
 * origin the browser will let the client talk to, which is a production bug the moment
 * the API is not on `localhost:8000`: a Railway deployment with
 * `VITE_API_BASE_URL=https://…/api/v1` builds and serves perfectly and then every single
 * request is blocked by the page's own policy, with nothing in the network tab and only a
 * console violation to go on.
 *
 * So the origin is **appended** rather than substituted:
 *
 *   * the policy is still an explicit allow-list, never a wildcard and never `*`;
 *   * it is derived from the one variable that already decides where requests go, so the
 *     two cannot drift apart;
 *   * a relative base (`/api/v1`, which is what the Vercel-proxy and `BM_DEV_API_PROXY`
 *     topologies use) adds nothing at all, because `'self'` already covers it;
 *   * `http://localhost:8000` stays in the literal, so local development, `vite preview`
 *     and the E2E suites behave exactly as before — for them this is a no-op.
 *
 * `tests/structural/rules.test.ts` reads the raw `index.html` and asserts the policy is
 * declared and strict; that file is untouched and the assertions still hold.
 */
function cspConnectSrc(): Plugin {
  let apiBaseUrl = '';

  return {
    name: 'bm-csp-connect-src',
    // `config.env` is Vite's own resolved environment, so this sees the value however it
    // was supplied: a `.env*` file, a shell variable, or the inline `VITE_`-prefixed form
    // that Vercel and `playwright.config.ts` both use (and which takes precedence).
    configResolved(config) {
      // Vite types `config.env` as `Record<string, any>`, so it is narrowed here rather
      // than read straight into a string — `no-unsafe-assignment` is a hard rule in this
      // repository (ADR-023) and `vite.config.ts` is not exempt from it.
      const env = config.env as Record<string, string | undefined>;
      apiBaseUrl = env['VITE_API_BASE_URL'] ?? '';
    },
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        if (!apiBaseUrl) return html;

        let parsed: URL;
        try {
          parsed = new URL(apiBaseUrl);
        } catch {
          // A relative base (`/api/v1`) — the Vercel-proxy and `BM_DEV_API_PROXY`
          // topologies both use one, and `'self'` already permits it.
          return html;
        }

        // Only an http(s) origin is a meaningful `connect-src` source. Anything else
        // parses to the opaque origin `"null"`, and appending that literal would put a
        // nonsense token in a security header — which is how a policy stops meaning what
        // it says. Reached by any value that parses as a URL without being a web origin:
        // a Windows path (`C:/…` is scheme `c:`), `file:`, `data:`. Not hypothetical —
        // Git Bash rewrote `/api/v1` to `C:/Program Files/Git/api/v1` while this was
        // being verified, and the build happily emitted `connect-src 'self' … null`.
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return html;

        const { origin } = parsed;
        return html.replace(/connect-src [^;"]*/, (directive) =>
          directive.includes(origin) ? directive : `${directive} ${origin}`,
        );
      },
    },
  };
}

/**
 * Optional `/api` proxy for local development and browser acceptance tests.
 *
 * Inert unless `BM_DEV_API_PROXY` is set, so nothing changes for a normal build.
 *
 * It exists because the app's own CSP allows `connect-src 'self' http://localhost:8000`
 * — correctly, it is a security control and is not being widened. With the proxy the
 * client keeps its default relative base (`/api/v1`), so requests go to the page's own
 * origin and satisfy `'self'` whatever port the API is on. That lets an acceptance run
 * use a throwaway API and database without touching a developer's running instance on
 * 8000, and without a CORS exemption.
 */
const apiProxy = process.env.BM_DEV_API_PROXY;
const proxy = apiProxy ? { '/api': { target: apiProxy, changeOrigin: true } } : undefined;

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    cspConnectSrc(),
    VitePWA({
      registerType: 'prompt',
      // ADR-031: the service worker caches the APP SHELL ONLY. No /api/ route is ever
      // cached and no mutation is ever queued by the service worker — a cached stock
      // figure or a replayed sale would both be worse than being offline.
      // tests/structural asserts no /api/ pattern appears in this config.
      workbox: {
        globPatterns: ['**/*.{js,css,html,woff2,png,svg}'],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [],
        cleanupOutdatedCaches: true,
        clientsClaim: false,
        skipWaiting: false,
      },
      manifest: {
        name: 'National Auto Spares — Counter',
        short_name: 'NAS Counter',
        description: 'Billing, stock and credit for National Auto Spares',
        theme_color: '#232852',
        background_color: '#ffffff',
        display: 'standalone',
        orientation: 'landscape',
        start_url: '/',
      },
    }),
  ],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    port: 5173,
    strictPort: true,
    ...(proxy ? { proxy } : {}),
  },
  preview: {
    ...(proxy ? { proxy } : {}),
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
