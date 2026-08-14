-- D64 — `Product.attributes` (convergence plan §4.6, Phase 7).
--
-- Behaviour goes in columns; description goes in `attributes`. The column is
-- validated server-side against the tenant descriptor's
-- `catalogue.attributeSchema`, never read by pricing, tax, inventory or
-- settlement, and GIN-indexed so domain screens can filter on it. Purely
-- additive: NOT NULL with DEFAULT '{}' backfills every existing row to the
-- valid empty document in the same statement — no data migration needed.
--
-- (The recurring `InventoryReceiptLine_productVariantId_fkey` drop/re-add
-- pair `migrate diff` emits — pre-existing D44 drift — is stripped, as in
-- every migration since.)

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "attributes" JSONB NOT NULL DEFAULT '{}';

-- CreateIndex
CREATE INDEX "Product_attributes_idx" ON "Product" USING GIN ("attributes");
