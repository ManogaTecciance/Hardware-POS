import { neonConfig } from '@neondatabase/serverless';
import { PrismaNeon } from '@prisma/adapter-neon';

import type {
  DatabaseConnectionProvider,
  PrismaClientOptions,
} from './database-connection-provider';

/**
 * Neon (https://neon.tech) via its serverless driver + Prisma driver adapter.
 *
 * Unlike plain TCP, the serverless driver speaks WebSocket/HTTP, which works
 * in edge/serverless runtimes and plays well with Neon's connection pooling
 * and scale-to-zero. The same `DATABASE_URL` (with `sslmode=require`) is used;
 * only the transport differs.
 */
export class NeonConnectionProvider implements DatabaseConnectionProvider {
  readonly kind = 'neon' as const;

  constructor(private readonly connectionString: string) {}

  clientOptions(): PrismaClientOptions {
    // Node < 22 has no global WebSocket; wire one up lazily if ever needed.
    if (typeof WebSocket !== 'undefined') {
      neonConfig.webSocketConstructor = WebSocket;
    }
    const adapter = new PrismaNeon({ connectionString: this.connectionString });
    return {
      adapter,
      // Remote serverless Postgres: every statement is a network round trip and
      // the first hit may wake a suspended compute. Prisma's defaults
      // (maxWait 2s / timeout 5s) abort multi-statement transactions on cold
      // starts with "Transaction not found".
      transactionOptions: { maxWait: 15_000, timeout: 30_000 },
    };
  }

  async dispose(): Promise<void> {
    // The adapter owns its pool and closes it with PrismaClient.$disconnect().
  }
}
