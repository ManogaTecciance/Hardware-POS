/**
 * Refuses to let the integration suite touch anything that could be a real
 * database. Called from `globalSetup` BEFORE any connection is opened, and again
 * (with the runtime shape check) once a client exists.
 *
 * A guard nobody tests is a guard that silently stops working, so this module is
 * pure and has its own spec — see `assert-test-database.spec.ts`.
 */

/** Hosts an integration test may legitimately reach. */
const ALLOWED_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  '[::1]',
  'host.docker.internal',
  // Docker Compose service names, for running the suite inside a container.
  'postgres-test',
  'db-test',
]);

/** Compose service names are the only hosts allowed to use the default port. */
const COMPOSE_HOSTS = new Set(['postgres-test', 'db-test']);

/**
 * Substrings that mark a URL as production-like. Matched against the whole
 * connection string (lower-cased) so a giveaway in the user, host, or database
 * name is caught wherever it appears.
 */
const DENYLISTED_SUBSTRINGS = [
  'amazonaws.com',
  'rds.',
  'neon.tech',
  'supabase.',
  'azure.com',
  'digitalocean.com',
  'render.com',
  'railway.app',
  'axlopos.com',
  'production',
  'prod',
  'staging',
  'live',
];

/** Above this row count the target looks like a real database, not a scratch one. */
export const MAX_PLAUSIBLE_SCRATCH_ROWS = 1_000;

export class UnsafeTestDatabaseError extends Error {
  constructor(reason: string, hint?: string) {
    super(
      `Refusing to run integration tests: ${reason}.` +
        (hint ? `\n  ${hint}` : '') +
        '\n  Expected a disposable database — see docker-compose.test.yml and' +
        ' apps/api/.env.test.example.',
    );
    this.name = 'UnsafeTestDatabaseError';
  }
}

export interface AssertTestDatabaseInput {
  nodeEnv: string | undefined;
  databaseUrl: string | undefined;
}

/**
 * Static checks against the environment. Throws {@link UnsafeTestDatabaseError}
 * unless every condition holds. Returns the parsed database name on success.
 */
export function assertTestDatabaseUrl({ nodeEnv, databaseUrl }: AssertTestDatabaseInput): string {
  // 1. NODE_ENV must be test.
  //
  //    Caveat worth knowing: Jest sets NODE_ENV=test itself when it is unset, so
  //    in practice this rejects an EXPLICITLY wrong value (`production`) rather
  //    than a missing one. It is therefore the weakest of the checks here — the
  //    database-name, host, port, and denylist rules below are what actually
  //    stand between this suite and a real database.
  if (nodeEnv !== 'test') {
    throw new UnsafeTestDatabaseError(
      `NODE_ENV is ${nodeEnv === undefined ? 'unset' : `"${nodeEnv}"`}, expected "test"`,
    );
  }

  // 2. DATABASE_URL must be present and parseable as a PostgreSQL URL.
  if (!databaseUrl) {
    throw new UnsafeTestDatabaseError('DATABASE_URL is not set');
  }

  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new UnsafeTestDatabaseError('DATABASE_URL is not a valid URL');
  }
  if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') {
    throw new UnsafeTestDatabaseError(`DATABASE_URL protocol "${url.protocol}" is not PostgreSQL`);
  }

  // 5. Denylist — checked early so an obviously-production URL fails with the
  //    clearest possible message, before the narrower structural checks.
  const haystack = databaseUrl.toLowerCase();
  for (const needle of DENYLISTED_SUBSTRINGS) {
    if (haystack.includes(needle)) {
      throw new UnsafeTestDatabaseError(
        `DATABASE_URL contains the production-like marker "${needle}"`,
      );
    }
  }

  // 3. Database name must end in _test.
  const database = url.pathname.replace(/^\//, '');
  if (!database) {
    throw new UnsafeTestDatabaseError('DATABASE_URL has no database name');
  }
  if (!/_test$/.test(database)) {
    throw new UnsafeTestDatabaseError(
      `database "${database}" does not end in "_test"`,
      'Point DATABASE_URL at hardware_pos_test.',
    );
  }

  // 4. Host must be local (or a known compose service).
  const host = url.hostname.toLowerCase();
  if (!ALLOWED_HOSTS.has(host)) {
    throw new UnsafeTestDatabaseError(
      `host "${host}" is not a recognised local test host`,
      `Allowed: ${[...ALLOWED_HOSTS].join(', ')}.`,
    );
  }

  // 6. Only compose service names may use the default port — this catches a dev
  //    URL that was edited to say _test but still points at the 5432 instance.
  const port = url.port || '5432';
  if (port === '5432' && !COMPOSE_HOSTS.has(host)) {
    throw new UnsafeTestDatabaseError(
      `port 5432 is the development/production port and host "${host}" is not a compose service`,
      'The test database listens on 5433 (see docker-compose.test.yml).',
    );
  }

  return database;
}

/** Minimal surface needed for the runtime shape check — keeps this module Prisma-free. */
export interface RowCounter {
  countSales(): Promise<number>;
}

/**
 * Runtime sanity check, run after the client connects: a scratch database is
 * either empty or nearly so. Guards against a URL that passes every static check
 * yet happens to address a database holding real trading history.
 */
export async function assertDatabaseLooksDisposable(counter: RowCounter): Promise<void> {
  let sales: number;
  try {
    sales = await counter.countSales();
  } catch {
    // The table does not exist yet (pre-migrate) — that is the safest possible
    // state, so there is nothing to object to.
    return;
  }

  if (sales > MAX_PLAUSIBLE_SCRATCH_ROWS) {
    throw new UnsafeTestDatabaseError(
      `the target database holds ${sales} Sale rows, which does not look disposable`,
      'Integration tests truncate every table. Aborting rather than destroying data.',
    );
  }
}
