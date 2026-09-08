/**
 * Single shared PrismaClient for the integration suite.
 *
 * Specs never construct their own client: one connection pool keeps `TRUNCATE`
 * between tests cheap and avoids "too many clients" once the suite grows. The
 * safety guard runs before the first connection is ever opened.
 */

import { PrismaClient } from '@hardware-pos/database';

import { assertDatabaseLooksDisposable, assertTestDatabaseUrl } from './assert-test-database';

let client: PrismaClient | undefined;

/** The shared client, created (and safety-checked) on first use. */
export function getTestPrisma(): PrismaClient {
  if (!client) {
    // Re-assert on the way in: `globalSetup` runs in a different process from the
    // test workers, so each worker verifies its own environment rather than
    // trusting that setup already did.
    assertTestDatabaseUrl({
      nodeEnv: process.env.NODE_ENV,
      databaseUrl: process.env.DATABASE_URL,
    });
    client = new PrismaClient({ log: ['warn', 'error'] });
  }
  return client;
}

/** Connect and run the runtime "does this look disposable?" check. */
export async function connectTestPrisma(): Promise<PrismaClient> {
  const prisma = getTestPrisma();
  await prisma.$connect();
  await assertDatabaseLooksDisposable({
    countSales: () => prisma.sale.count(),
  });
  return prisma;
}

export async function disconnectTestPrisma(): Promise<void> {
  if (client) {
    await client.$disconnect();
    client = undefined;
  }
}
