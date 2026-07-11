/**
 * @hardware-pos/database
 *
 * Exposes a single shared PrismaClient instance for the API to consume.
 * A global singleton avoids exhausting the connection pool during development
 * hot-reloads.
 *
 * NOTE: Run `pnpm --filter @hardware-pos/database db:generate` to generate the
 * Prisma client before importing this in a consuming app.
 */

import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['query', 'warn', 'error'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

export * from '@prisma/client';
export * from './mock-catalog';
export * from './connection/database-connection-provider';
export * from './connection/postgres-connection-provider';
export * from './connection/neon-connection-provider';
export * from './connection/create-database-connection-provider';
