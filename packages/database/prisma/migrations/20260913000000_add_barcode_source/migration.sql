-- D125 Part 3 — barcode provenance and uniqueness (Phase 5, step 5.6).
--
-- Additive. One new enum, one new nullable column, one unique index. Nothing is
-- backfilled and no existing barcode is read, rewritten or cleared.
--
-- Why the column is nullable with no default: the twenty barcodes already in
-- the pilot database predate this flag, and nothing records who issued them. A
-- default of INTERNAL would be a guess that authorises overwriting a supplier's
-- code — exactly the silent damage this phase must not cause. NULL means
-- unknown, which is the truth, and 5.9 sets it explicitly for the rows it can
-- prove are shop-generated.
--
-- Why the unique index needs no remediation: the D125 investigation measured
-- every row first — 48 variants, 20 with a barcode, zero duplicates within a
-- tenant and zero across tenants. Postgres treats NULLs as distinct in a unique
-- index, so the 28 variants with no barcode are unaffected and can stay that
-- way indefinitely.

-- CreateEnum
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'BarcodeSource') THEN
    CREATE TYPE "BarcodeSource" AS ENUM ('SUPPLIER', 'INTERNAL');
  END IF;
END
$$;

-- AlterTable
ALTER TABLE "ProductVariant"
  ADD COLUMN IF NOT EXISTS "barcodeSource" "BarcodeSource";

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "ProductVariant_tenantId_barcode_key"
  ON "ProductVariant"("tenantId", "barcode");
