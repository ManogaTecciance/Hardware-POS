/**
 * Jest config for the API's fast suite — no Docker, no database.
 *
 * Picks up:
 *   • unit specs co-located as `*.spec.ts` under `src`, which mock all I/O
 *     (Prisma / HTTP / QuickBooks);
 *   • pure specs under `test/integration/` that guard the integration harness
 *     itself — notably `assert-test-database.spec.ts`. They need no database, and
 *     the production-URL guard is precisely the thing that must never quietly
 *     stop working, so it runs on every `pnpm test`.
 *
 * Excludes `test/integration/specs/`, which needs a real disposable PostgreSQL.
 * Those run via `pnpm test:integration` — see
 * test/integration/jest.integration.config.js and
 * docs/restaurant-pos/phase-01-plan.md.
 */
/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  roots: ['<rootDir>/src', '<rootDir>/test/integration'],
  testRegex: '.*\\.spec\\.ts$',
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/test/integration/specs/'],
  moduleFileExtensions: ['ts', 'js', 'json'],
};
