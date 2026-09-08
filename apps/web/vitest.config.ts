import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * Vitest for the web workspace. Node environment is enough — the dashboard chart
 * logic under test is pure (data transforms + formatters), with no DOM needed.
 * The `@/` alias mirrors tsconfig `paths` so specs import exactly like app code.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // Point at the source, not the built dist: otherwise a stale build makes
      // the shared timezone specs quietly test yesterday's code.
      '@hardware-pos/shared': fileURLToPath(
        new URL('../../packages/shared/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
  },
});
