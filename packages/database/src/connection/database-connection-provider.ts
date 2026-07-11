import type { PrismaClient } from '@prisma/client';

/** Options accepted by `new PrismaClient(...)` — version-safe alias. */
export type PrismaClientOptions = NonNullable<ConstructorParameters<typeof PrismaClient>[0]>;

/** Databases the app knows how to connect to. */
export const DATABASE_PROVIDER_KINDS = ['postgres', 'neon'] as const;
export type DatabaseProviderKind = (typeof DATABASE_PROVIDER_KINDS)[number];

/**
 * Abstraction over HOW the app connects to its database.
 *
 * The rest of the codebase only ever talks to Prisma; a provider's sole job is
 * to hand Prisma the right constructor options for a given backend (plain
 * PostgreSQL over TCP, Neon over its serverless driver, ...). Swapping
 * databases is therefore an environment change (`DB_PROVIDER` +
 * `DATABASE_URL`), never a code change.
 */
export interface DatabaseConnectionProvider {
  /** Which backend this provider connects to. */
  readonly kind: DatabaseProviderKind;

  /** Build the options handed to `new PrismaClient(...)`. */
  clientOptions(): PrismaClientOptions;

  /**
   * Release resources owned by the provider itself (driver pools, sockets).
   * Called after `PrismaClient.$disconnect()` on shutdown.
   */
  dispose(): Promise<void>;
}
