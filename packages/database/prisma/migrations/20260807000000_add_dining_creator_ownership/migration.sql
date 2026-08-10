-- Restaurant Pilot Change 1 — creator-owned dining areas and tables.
--
-- Two additive columns, one FK per column, one index per column, plus a
-- one-shot backfill that attributes existing (pre-change) rows to the
-- tenant's first active OWNER. Legacy rows that end up with no owner (a
-- tenant with no active OWNER) stay NULL and are unmanageable — that is
-- the correct fail-closed default.
--
-- Additive per D15/D30. Nothing dropped, no column altered, no data
-- rewritten except the deliberate one-time attribution of ownerless rows.

-- ── DiningArea ────────────────────────────────────────────────────────────

ALTER TABLE "DiningArea"
  ADD COLUMN "createdByUserId" TEXT;

ALTER TABLE "DiningArea"
  ADD CONSTRAINT "DiningArea_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "DiningArea_createdByUserId_idx" ON "DiningArea"("createdByUserId");

-- Backfill: attribute existing rows to the tenant's earliest active OWNER.
-- Correlated subquery so each row picks a user in its own tenant only.
UPDATE "DiningArea"
SET "createdByUserId" = (
  SELECT u."id"
  FROM "User" u
  WHERE u."tenantId" = "DiningArea"."tenantId"
    AND u."role" = 'OWNER'
    AND u."isActive" = true
  ORDER BY u."createdAt" ASC
  LIMIT 1
)
WHERE "createdByUserId" IS NULL;

-- ── RestaurantTable ───────────────────────────────────────────────────────

ALTER TABLE "RestaurantTable"
  ADD COLUMN "createdByUserId" TEXT;

ALTER TABLE "RestaurantTable"
  ADD CONSTRAINT "RestaurantTable_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "RestaurantTable_createdByUserId_idx" ON "RestaurantTable"("createdByUserId");

UPDATE "RestaurantTable"
SET "createdByUserId" = (
  SELECT u."id"
  FROM "User" u
  WHERE u."tenantId" = "RestaurantTable"."tenantId"
    AND u."role" = 'OWNER'
    AND u."isActive" = true
  ORDER BY u."createdAt" ASC
  LIMIT 1
)
WHERE "createdByUserId" IS NULL;
