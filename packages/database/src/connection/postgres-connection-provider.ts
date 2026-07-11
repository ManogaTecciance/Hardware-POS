import type {
  DatabaseConnectionProvider,
  PrismaClientOptions,
} from './database-connection-provider';

/**
 * Standard PostgreSQL over TCP — any Postgres that speaks the wire protocol
 * directly (local docker/podman, RDS, Cloud SQL, a bare-metal server, ...).
 * Prisma's built-in driver manages its own pool, so there is nothing to
 * dispose beyond `$disconnect()`.
 */
export class PostgresConnectionProvider implements DatabaseConnectionProvider {
  readonly kind = 'postgres' as const;

  constructor(private readonly connectionString: string) {}

  clientOptions(): PrismaClientOptions {
    return { datasourceUrl: this.connectionString };
  }

  async dispose(): Promise<void> {
    // No provider-owned resources; Prisma owns the connection pool.
  }
}
