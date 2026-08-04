-- Rollback for migration 20260804121830_add_tenant_platform_profile.
--
-- Prisma Migrate has no `down` step, so the reverse SQL is kept here and is
-- exercised against a disposable database by the Slice 4 rollback test. Keeping
-- it in version control means the forward migration is never approved without a
-- tested way back.
--
-- Safe because the forward migration is strictly additive: dropping these two
-- tables and four enum types returns the schema to exactly its previous state.
-- No pre-existing table, column, constraint, or row is involved.
--
-- The only data lost is platform-profile configuration written after the forward
-- migration — which is the intended meaning of rolling this change back. Every
-- tenant then resolves to the legacy Tile Shop configuration again, which is the
-- same behaviour it had before the forward migration.
--
-- Usage against a disposable database:
--   psql "$DATABASE_URL" -f 20260804121830_add_tenant_platform_profile.down.sql
--   -- then, to let Prisma re-apply the forward migration:
--   DELETE FROM "_prisma_migrations"
--    WHERE "migration_name" = '20260804121830_add_tenant_platform_profile';

-- Foreign keys are dropped implicitly with their tables.
DROP TABLE IF EXISTS "TenantModule";
DROP TABLE IF EXISTS "TenantBusinessProfile";

DROP TYPE IF EXISTS "ModuleKey";
DROP TYPE IF EXISTS "AccountingProviderKind";
DROP TYPE IF EXISTS "InventoryMode";
DROP TYPE IF EXISTS "BusinessType";
