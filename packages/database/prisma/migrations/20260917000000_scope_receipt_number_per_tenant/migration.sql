-- D192 — `Receipt.receiptNumber` is unique per TENANT, not globally.
--
-- `receiptNumber` is built as `RCP-<sale.saleNumber>`, and `Sale` is
-- `@@unique([tenantId, saleNumber])` — every tenant's numbering restarts at
-- S-000001. A GLOBAL unique on the receipt number therefore means the first
-- tenant to print its sale N permanently claims that string, and every other
-- tenant printing their own sale N gets a P2002 surfaced as a hard 500.
--
-- Not theoretical: on the development database at the time of writing,
-- S-000001, S-000002 and S-000003 each exist in FOUR tenants with exactly ONE
-- receipt printed between them.
--
-- `InventoryReceipt` has carried `@@unique([tenantId, receiptNumber])` since it
-- was introduced. This brings `Receipt` into line with its sibling rather than
-- inventing a new shape.
--
-- ## Data safety
--
-- Additive then narrowing, in the only order that is safe on a populated table:
-- add the column nullable, backfill every row from the sale it already belongs
-- to, and only then set NOT NULL. No row moves between tenants — each receipt
-- takes the tenant of its own sale, which is where it was already reachable
-- from. `Receipt.saleId` is NOT NULL and `@unique`, so the backfill covers
-- every row and cannot produce two answers for one receipt.
--
-- The narrowing is safe because the OLD constraint was strictly stronger than
-- the new one: anything globally unique is unique within a tenant, so no
-- existing row can violate the composite index. A migration that loosens a
-- constraint cannot fail on data that satisfied the tighter one.
--
-- The receipt NUMBER FORMAT is unchanged. Every existing receipt keeps the
-- string it was printed with, so a reprint of a hardware or restaurant receipt
-- renders byte-for-byte what it rendered before.

-- AlterTable: nullable first, so existing rows are legal while we fill them.
ALTER TABLE "Receipt" ADD COLUMN "tenantId" TEXT;

-- Backfill from the owning sale. Every receipt has exactly one.
UPDATE "Receipt" r
SET "tenantId" = s."tenantId"
FROM "Sale" s
WHERE s."id" = r."saleId";

-- Now it can be required.
ALTER TABLE "Receipt" ALTER COLUMN "tenantId" SET NOT NULL;

-- DropIndex: the global unique that caused the 500.
DROP INDEX "Receipt_receiptNumber_key";

-- CreateIndex
CREATE UNIQUE INDEX "Receipt_tenantId_receiptNumber_key" ON "Receipt"("tenantId", "receiptNumber");

-- CreateIndex
CREATE INDEX "Receipt_tenantId_idx" ON "Receipt"("tenantId");

-- AddForeignKey: CASCADE, matching every other tenant-scoped table.
ALTER TABLE "Receipt" ADD CONSTRAINT "Receipt_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
