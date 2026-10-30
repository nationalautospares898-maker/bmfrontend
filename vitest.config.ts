import { fileURLToPath, URL } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}', 'tests/**/*.test.{ts,tsx}'],
    exclude: ['tests/e2e/**'],
    coverage: {
      // Istanbul, not v8. The v8 provider attributes an unreachable artifact to line 1
      // of every module whose source begins with a comment, which made the 100%
      // threshold below unsatisfiable however complete the tests were — and a threshold
      // that can never pass is a threshold nobody believes. Istanbul instruments the
      // source, so the figure refers to the code.
      provider: 'istanbul',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/api/generated/**', 'src/**/*.test.{ts,tsx}', 'src/main.tsx'],
      thresholds: {
        // `src/lib/money.ts` requires 100% branch coverage (§12). It is the one file
        // where an untested branch is a wrong number on a customer's bill.
        'src/lib/money.ts': {
          branches: 100,
          functions: 100,
          lines: 100,
          statements: 100,
        },
      },
    },
  },
});
