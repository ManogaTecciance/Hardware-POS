-- Phase 1.5, decision D40. Purely additive: one nullable column and one unique
-- index. No data migration, because `Role` holds no rows in any environment.
--
-- `Role` was keyed on `name`, a display label a tenant may customise. Resolving a
-- built-in role by the string an admin can rename is a defect waiting to happen:
-- the lookup either misses and creates a duplicate, or misses and grants nothing.
-- `key` is the stable identifier (OWNER, MANAGER, WAITER, …); `name` stays
-- presentation-only. Nullable so the column could be added without a backfill.

-- AlterTable
ALTER TABLE "Role" ADD COLUMN     "key" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Role_tenantId_key_key" ON "Role"("tenantId", "key");
