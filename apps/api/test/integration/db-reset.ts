/**
 * Between-test cleanup.
 *
 * The table list is discovered from `information_schema` rather than hardcoded, so
 * it cannot drift as models are added — a hardcoded list silently stops truncating
 * new tables and leaks state between specs. `_prisma_migrations` is excluded so the
 * applied-migration history survives.
 */

import type { PrismaClient } from '@hardware-pos/database';

const PRESERVED_TABLES = new Set(['_prisma_migrations']);

let cachedTables: string[] | undefined;

/** Every truncatable table in the `public` schema. Cached per worker process. */
export async function discoverTables(prisma: PrismaClient): Promise<string[]> {
  if (cachedTables) return cachedTables;

  const rows = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public'
  `;

  cachedTables = rows.map((r) => r.tablename).filter((t) => !PRESERVED_TABLES.has(t));
  return cachedTables;
}

/**
 * Wipe all data. One statement so foreign keys never need disabling: `CASCADE`
 * covers the references, and every table is in the list anyway.
 */
export async function resetDatabase(prisma: PrismaClient): Promise<void> {
  const tables = await discoverTables(prisma);
  if (tables.length === 0) return;

  const quoted = tables.map((t) => `"public"."${t}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${quoted} RESTART IDENTITY CASCADE`);
}

/** Forget the cached table list (call after applying a migration mid-suite). */
export function invalidateTableCache(): void {
  cachedTables = undefined;
}
