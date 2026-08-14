-- D57 — one business type per template (convergence plan §4.8.1).
--
-- Removes TILE_SHOP and RETAIL from "BusinessType". Postgres cannot DROP a
-- value from an enum in place, so the type is recreated — the one deliberately
-- non-additive migration authorised by D57; the per-migration proof in
-- provider-contract.spec.ts scopes an exception for exactly this shape.
--
-- Guard: verified at authoring time that no TenantBusinessProfile row carries
-- either value (the enum's only column). The DO block re-asserts that wherever
-- this deploys, with a clear message instead of a cast error, and aborts the
-- transaction before any type change if production disagrees.

DO $$
DECLARE
  stranded integer;
BEGIN
  SELECT count(*) INTO stranded
  FROM "TenantBusinessProfile"
  WHERE "businessType"::text IN ('TILE_SHOP', 'RETAIL');
  IF stranded > 0 THEN
    RAISE EXCEPTION
      'D57 migration refused: % TenantBusinessProfile row(s) still carry TILE_SHOP or RETAIL. Reclassify them (expected: HARDWARE) before removing the values.',
      stranded;
  END IF;
END $$;

-- AlterEnum
BEGIN;
CREATE TYPE "BusinessType_new" AS ENUM ('HARDWARE', 'RESTAURANT', 'CAFE', 'BAKERY', 'HOTEL', 'GENERAL');
ALTER TABLE "TenantBusinessProfile" ALTER COLUMN "businessType" TYPE "BusinessType_new" USING ("businessType"::text::"BusinessType_new");
ALTER TYPE "BusinessType" RENAME TO "BusinessType_old";
ALTER TYPE "BusinessType_new" RENAME TO "BusinessType";
DROP TYPE "public"."BusinessType_old";
COMMIT;
