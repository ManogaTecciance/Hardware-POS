/**
 * Jest config for the API integration suite.
 *
 * Separate from `jest.config.js` (whose rootDir is `src`) so the default
 * `pnpm test` stays fast and needs no Docker. Run it with
 * `pnpm test:integration` from the repo root, which brings the disposable
 * PostgreSQL up first.
 *
 * `maxWorkers: 1` is deliberate: every spec truncates the shared database between
 * tests, so parallel workers would clobber each other. Correctness before speed —
 * revisit with per-worker schemas only if the suite gets slow enough to matter.
 */
/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: __dirname,
  testRegex: '.*\\.spec\\.ts$',
  moduleFileExtensions: ['ts', 'js', 'json'],
  globalSetup: '<rootDir>/global-setup.ts',
  // Booting Nest + applying migrations is slower than a unit spec.
  testTimeout: 60_000,
  maxWorkers: 1,
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      { tsconfig: require('node:path').resolve(__dirname, '../tsconfig.json') },
    ],
  },
};
