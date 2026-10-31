import { fileURLToPath, URL } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

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
