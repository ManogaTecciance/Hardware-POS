import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * Vitest for the web workspace.
 *
 * Node is still the default — the dashboard chart logic, the supplier formatters
 * and the product presentation resolver are all pure. `jsdom` was added in Slice
 * 6C-B.5 for the `*.render.test.tsx` specs only.
 *
 * Those specs need a real DOM for a reason the architectural-test standard makes
 * explicit: asserting "the Sync to QuickBooks button is not rendered" from source
 * text cannot distinguish the button being absent from the pattern no longer
 * matching, and a renamed component would make the check inspect nothing at all.
 * Rendering the component and querying it by accessible role can tell those apart.
 *
 * The `@/` alias mirrors tsconfig `paths` so specs import exactly like app code.
 */
export default defineConfig({
  // Next compiles JSX with the automatic runtime, so app components legitimately
  // use JSX without importing React. Vitest's default is the classic runtime,
  // which turns those files into "React is not defined" at render time.
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // The workspace root carries its own physical `react`/`react-dom` alongside
      // the pnpm-linked ones this app uses. Testing Library resolved the root pair
      // while the components resolved the linked pair, which gives every hook a
      // null dispatcher. Pinning both to this workspace's copies is what makes the
      // render specs run at all.
      react: fileURLToPath(new URL('../../node_modules/react', import.meta.url)),
      'react-dom': fileURLToPath(new URL('../../node_modules/react-dom', import.meta.url)),
    },
    dedupe: ['react', 'react-dom'],
  },
  test: {
    environment: 'node',
    environmentMatchGlobs: [['**/*.render.test.tsx', 'jsdom']],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
  },
});
