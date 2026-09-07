/**
 * Jest globalSetup for the integration suite.
 *
 * Order matters: the safety guard runs FIRST, before any connection is opened and
 * before `prisma migrate deploy` could touch a schema. If the environment is not a
 * disposable test database, nothing else happens.
 *
 * `migrate deploy` (not `migrate dev`) is used deliberately — the suite must
 * validate the exact SQL production will receive, with no interactive drift
 * detection and no shadow database.
 */

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

import { UnsafeTestDatabaseError, assertTestDatabaseUrl } from './assert-test-database';

const DATABASE_PACKAGE = resolve(__dirname, '../../../../packages/database');

export default function globalSetup(): void {
  let database: string;
  try {
    database = assertTestDatabaseUrl({
      nodeEnv: process.env.NODE_ENV,
      databaseUrl: process.env.DATABASE_URL,
    });
  } catch (err) {
    if (err instanceof UnsafeTestDatabaseError) {
      // A stack trace adds nothing here and buries the actionable message.
      console.error(`\n${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }

  console.log(`[integration] Target database: ${database} (verified disposable)`);
  console.log('[integration] Applying migrations (prisma migrate deploy)...');

  // On Windows the binary is `pnpm.cmd`, and Node (post CVE-2024-27980)
  // refuses to spawn a .cmd without a shell — without both of these the suite
  // dies in ENOENT before a single test on any Windows dev machine.
  execFileSync(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    cwd: DATABASE_PACKAGE,
    stdio: 'inherit',
    env: process.env,
    ...(process.platform === 'win32' ? { shell: true } : {}),
  });

  console.log('[integration] Schema ready.');
}
