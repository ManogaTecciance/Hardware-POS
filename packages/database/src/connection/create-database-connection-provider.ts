import {
  DATABASE_PROVIDER_KINDS,
  type DatabaseConnectionProvider,
  type DatabaseProviderKind,
} from './database-connection-provider';
import { NeonConnectionProvider } from './neon-connection-provider';
import { PostgresConnectionProvider } from './postgres-connection-provider';

export interface DatabaseConnectionEnv {
  /** One of DATABASE_PROVIDER_KINDS. Defaults to 'postgres'. */
  DB_PROVIDER?: string;
  DATABASE_URL?: string;
}

function isKind(value: string): value is DatabaseProviderKind {
  return (DATABASE_PROVIDER_KINDS as readonly string[]).includes(value);
}

/**
 * Resolve the connection provider from the environment.
 *
 * `DATABASE_URL` says WHERE the database is; `DB_PROVIDER` says HOW to reach
 * it ('postgres' = Prisma's built-in TCP driver, 'neon' = Neon's serverless
 * driver). Point both at a different backend and the app follows — no code
 * changes anywhere else.
 */
export function createDatabaseConnectionProvider(
  env: DatabaseConnectionEnv = process.env,
): DatabaseConnectionProvider {
  const url = env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is not set');
  }

  const kind = env.DB_PROVIDER ?? 'postgres';
  if (!isKind(kind)) {
    throw new Error(
      `Unknown DB_PROVIDER "${kind}" — expected one of: ${DATABASE_PROVIDER_KINDS.join(', ')}`,
    );
  }

  switch (kind) {
    case 'neon':
      return new NeonConnectionProvider(url);
    case 'postgres':
      return new PostgresConnectionProvider(url);
  }
}
