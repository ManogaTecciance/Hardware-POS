-- Product variants + purchase receipts + weighted-average costing (D44).
-- Additive per D15: no destructive column change, no data loss.
--
-- Adds:
--   • ProductVariationDimension / ProductVariationOption — the wizard's Step 2
--     variation groups + option lists ("Size" → 200ml/300ml/500ml).
--   • ProductVariant — one row per sellable combination. Independent SKU,
--     barcode, unit price, cost, average cost, reorder point, image, status.
--   • ProductVariantOptionValue — junction fixing a variant to (one option
--     per dimension) so the combination is queryable and stable.
--   • InventoryReceipt / InventoryReceiptLine — Receive Stock (Purchase
--     Receipt) header + lines. Immutable receipt cost history so the
--     weighted-average calculator can revisit past receipts and a future
--     FIFO policy can walk them lot-by-lot.
--   • Nullable `productVariantId` and (where a cost snapshot matters)
--     `unitCost` on SaleItem, ReturnItem, MenuItem, BranchInventory,
--     StockMovement. Every legacy row remains valid without backfill.
--   • Product.hasVariants + Product.averageCost — the parent header
--     reflects whether variants own the sellable dimensions and holds the
--     weighted-average cost for legacy (variant-less) products.
--   • BranchInventory.averageCost — per-variant weighted-average snapshot
--     scoped to the branch that receives it.
--   • RECEIPT value on StockMovementReason so the ledger records receipts.
--
-- Cost history rule (D44). Historical purchase costs are NEVER overwritten:
-- every receipt inserts an immutable InventoryReceiptLine and the append-only
-- StockMovement row that describes the balance change. `averageCost` is a
-- rollup, not a source of truth — recomputed on receipt and always derivable
-- from the ledger + line history.
--
-- BranchInventory uniqueness. The empty (branchId, productId) unique cannot
-- accommodate multi-variant rows on the same product. `BranchInventory` holds
-- zero rows in every environment (Phase 2.5 shipped the table but no code
-- wrote to it yet — this migration is its first writer), so the constraint
-- swap is data-safe. Replaced with two partial unique indexes:
--   • (branchId, productId) WHERE productVariantId IS NULL — legacy rows.
--   • (branchId, productVariantId) WHERE productVariantId IS NOT NULL —
--     variant rows.
-- Together the two indexes give exactly-one-row-per-cell semantics with no
-- reliance on Postgres NULLS-NOT-DISTINCT syntax (portable to PG14+).

-- ─────────────────────────────────────────────────────────────
-- Enums
-- ─────────────────────────────────────────────────────────────

ALTER TYPE "StockMovementReason" ADD VALUE IF NOT EXISTS 'RECEIPT';

-- ─────────────────────────────────────────────────────────────
-- ProductVariationDimension
-- ─────────────────────────────────────────────────────────────

CREATE TABLE "ProductVariationDimension" (
    "id"        TEXT NOT NULL,
    "tenantId"  TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "name"      TEXT NOT NULL,
    "position"  INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductVariationDimension_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProductVariationDimension_productId_name_key"
    ON "ProductVariationDimension"("productId", "name");
CREATE INDEX "ProductVariationDimension_tenantId_idx"
    ON "ProductVariationDimension"("tenantId");
CREATE INDEX "ProductVariationDimension_productId_idx"
    ON "ProductVariationDimension"("productId");

ALTER TABLE "ProductVariationDimension"
    ADD CONSTRAINT "ProductVariationDimension_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProductVariationDimension"
    ADD CONSTRAINT "ProductVariationDimension_productId_fkey"
    FOREIGN KEY ("productId") REFERENCES "Product"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────
-- ProductVariationOption
-- ─────────────────────────────────────────────────────────────

CREATE TABLE "ProductVariationOption" (
    "id"          TEXT NOT NULL,
    "tenantId"    TEXT NOT NULL,
    "dimensionId" TEXT NOT NULL,
    "name"        TEXT NOT NULL,
    "position"    INTEGER NOT NULL DEFAULT 0,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductVariationOption_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProductVariationOption_dimensionId_name_key"
    ON "ProductVariationOption"("dimensionId", "name");
CREATE INDEX "ProductVariationOption_tenantId_idx"
    ON "ProductVariationOption"("tenantId");
CREATE INDEX "ProductVariationOption_dimensionId_idx"
    ON "ProductVariationOption"("dimensionId");

ALTER TABLE "ProductVariationOption"
    ADD CONSTRAINT "ProductVariationOption_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProductVariationOption"
    ADD CONSTRAINT "ProductVariationOption_dimensionId_fkey"
    FOREIGN KEY ("dimensionId") REFERENCES "ProductVariationDimension"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────
-- ProductVariant
-- ─────────────────────────────────────────────────────────────

CREATE TABLE "ProductVariant" (
    "id"           TEXT NOT NULL,
    "tenantId"     TEXT NOT NULL,
    "productId"    TEXT NOT NULL,
    "sku"          TEXT NOT NULL,
    "barcode"      TEXT,
    "unitPrice"    DECIMAL(12,2) NOT NULL DEFAULT 0,
    "costPrice"    DECIMAL(12,2),
    "averageCost"  DECIMAL(12,4),
    "reorderLevel" DECIMAL(12,3),
    "imageUrl"     TEXT,
    "position"     INTEGER NOT NULL DEFAULT 0,
    "isActive"     BOOLEAN NOT NULL DEFAULT true,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"    TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductVariant_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProductVariant_tenantId_sku_key"
    ON "ProductVariant"("tenantId", "sku");
CREATE UNIQUE INDEX "ProductVariant_tenantId_barcode_key"
    ON "ProductVariant"("tenantId", "barcode")
    WHERE "barcode" IS NOT NULL;
CREATE INDEX "ProductVariant_tenantId_idx"
    ON "ProductVariant"("tenantId");
CREATE INDEX "ProductVariant_productId_idx"
    ON "ProductVariant"("productId");
CREATE INDEX "ProductVariant_isActive_idx"
    ON "ProductVariant"("isActive");

ALTER TABLE "ProductVariant"
    ADD CONSTRAINT "ProductVariant_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProductVariant"
    ADD CONSTRAINT "ProductVariant_productId_fkey"
    FOREIGN KEY ("productId") REFERENCES "Product"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────
-- ProductVariantOptionValue (variant ↔ dimension ↔ option junction)
-- ─────────────────────────────────────────────────────────────

CREATE TABLE "ProductVariantOptionValue" (
    "id"          TEXT NOT NULL,
    "tenantId"    TEXT NOT NULL,
    "variantId"   TEXT NOT NULL,
    "dimensionId" TEXT NOT NULL,
    "optionId"    TEXT NOT NULL,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductVariantOptionValue_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProductVariantOptionValue_variantId_dimensionId_key"
    ON "ProductVariantOptionValue"("variantId", "dimensionId");
CREATE INDEX "ProductVariantOptionValue_tenantId_idx"
    ON "ProductVariantOptionValue"("tenantId");
CREATE INDEX "ProductVariantOptionValue_optionId_idx"
    ON "ProductVariantOptionValue"("optionId");
CREATE INDEX "ProductVariantOptionValue_dimensionId_idx"
    ON "ProductVariantOptionValue"("dimensionId");

ALTER TABLE "ProductVariantOptionValue"
    ADD CONSTRAINT "ProductVariantOptionValue_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProductVariantOptionValue"
    ADD CONSTRAINT "ProductVariantOptionValue_variantId_fkey"
    FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProductVariantOptionValue"
    ADD CONSTRAINT "ProductVariantOptionValue_dimensionId_fkey"
    FOREIGN KEY ("dimensionId") REFERENCES "ProductVariationDimension"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProductVariantOptionValue"
    ADD CONSTRAINT "ProductVariantOptionValue_optionId_fkey"
    FOREIGN KEY ("optionId") REFERENCES "ProductVariationOption"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────
-- Product additive columns
-- ─────────────────────────────────────────────────────────────

ALTER TABLE "Product"
    ADD COLUMN "hasVariants" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "averageCost" DECIMAL(12,4);

-- ─────────────────────────────────────────────────────────────
-- SaleItem / ReturnItem / MenuItem additive variant links
-- ─────────────────────────────────────────────────────────────

ALTER TABLE "SaleItem"
    ADD COLUMN "productVariantId" TEXT,
    ADD COLUMN "variantSkuSnapshot" TEXT,
    ADD COLUMN "variantNameSnapshot" TEXT;
CREATE INDEX "SaleItem_productVariantId_idx"
    ON "SaleItem"("productVariantId");
ALTER TABLE "SaleItem"
    ADD CONSTRAINT "SaleItem_productVariantId_fkey"
    FOREIGN KEY ("productVariantId") REFERENCES "ProductVariant"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ReturnItem"
    ADD COLUMN "productVariantId" TEXT,
    ADD COLUMN "variantSkuSnapshot" TEXT,
    ADD COLUMN "variantNameSnapshot" TEXT;
CREATE INDEX "ReturnItem_productVariantId_idx"
    ON "ReturnItem"("productVariantId");
ALTER TABLE "ReturnItem"
    ADD CONSTRAINT "ReturnItem_productVariantId_fkey"
    FOREIGN KEY ("productVariantId") REFERENCES "ProductVariant"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "MenuItem"
    ADD COLUMN "productVariantId" TEXT;
CREATE INDEX "MenuItem_productVariantId_idx"
    ON "MenuItem"("productVariantId");
ALTER TABLE "MenuItem"
    ADD CONSTRAINT "MenuItem_productVariantId_fkey"
    FOREIGN KEY ("productVariantId") REFERENCES "ProductVariant"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────
-- BranchInventory — extend for variants
-- ─────────────────────────────────────────────────────────────
--
-- Drop the (branchId, productId) unique (empty table, no data loss) and
-- replace it with two partial unique indexes so a Product's variants can each
-- hold a per-branch balance without collision, while legacy (variant-less)
-- rows still get exactly-one-row-per-(branch, product).

DROP INDEX "BranchInventory_branchId_productId_key";

ALTER TABLE "BranchInventory"
    ADD COLUMN "productVariantId" TEXT,
    ADD COLUMN "averageCost"      DECIMAL(12,4);

CREATE UNIQUE INDEX "BranchInventory_branchId_productId_legacy_key"
    ON "BranchInventory"("branchId", "productId")
    WHERE "productVariantId" IS NULL;
CREATE UNIQUE INDEX "BranchInventory_branchId_productVariantId_key"
    ON "BranchInventory"("branchId", "productVariantId")
    WHERE "productVariantId" IS NOT NULL;
CREATE INDEX "BranchInventory_productVariantId_idx"
    ON "BranchInventory"("productVariantId");

ALTER TABLE "BranchInventory"
    ADD CONSTRAINT "BranchInventory_productVariantId_fkey"
    FOREIGN KEY ("productVariantId") REFERENCES "ProductVariant"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────
-- StockMovement — variant column + optional unit cost snapshot
-- ─────────────────────────────────────────────────────────────

ALTER TABLE "StockMovement"
    ADD COLUMN "productVariantId" TEXT,
    ADD COLUMN "unitCost"         DECIMAL(12,2);

CREATE INDEX "StockMovement_productVariantId_idx"
    ON "StockMovement"("productVariantId");

ALTER TABLE "StockMovement"
    ADD CONSTRAINT "StockMovement_productVariantId_fkey"
    FOREIGN KEY ("productVariantId") REFERENCES "ProductVariant"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────
-- InventoryReceipt
-- ─────────────────────────────────────────────────────────────

CREATE TABLE "InventoryReceipt" (
    "id"               TEXT NOT NULL,
    "tenantId"         TEXT NOT NULL,
    "branchId"         TEXT NOT NULL,
    "supplierId"       TEXT,
    "receiptNumber"    TEXT NOT NULL,
    "receivedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "invoiceReference" TEXT,
    "grnReference"     TEXT,
    "notes"            TEXT,
    "createdByUserId"  TEXT NOT NULL,
    "idempotencyKey"   TEXT,
    "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"        TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InventoryReceipt_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "InventoryReceipt_tenantId_receiptNumber_key"
    ON "InventoryReceipt"("tenantId", "receiptNumber");
CREATE UNIQUE INDEX "InventoryReceipt_tenantId_idempotencyKey_key"
    ON "InventoryReceipt"("tenantId", "idempotencyKey")
    WHERE "idempotencyKey" IS NOT NULL;
CREATE INDEX "InventoryReceipt_tenantId_idx"
    ON "InventoryReceipt"("tenantId");
CREATE INDEX "InventoryReceipt_branchId_idx"
    ON "InventoryReceipt"("branchId");
CREATE INDEX "InventoryReceipt_supplierId_idx"
    ON "InventoryReceipt"("supplierId");
CREATE INDEX "InventoryReceipt_receivedAt_idx"
    ON "InventoryReceipt"("receivedAt");

ALTER TABLE "InventoryReceipt"
    ADD CONSTRAINT "InventoryReceipt_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InventoryReceipt"
    ADD CONSTRAINT "InventoryReceipt_branchId_fkey"
    FOREIGN KEY ("branchId") REFERENCES "Branch"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InventoryReceipt"
    ADD CONSTRAINT "InventoryReceipt_supplierId_fkey"
    FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "InventoryReceipt"
    ADD CONSTRAINT "InventoryReceipt_createdByUserId_fkey"
    FOREIGN KEY ("createdByUserId") REFERENCES "User"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────
-- InventoryReceiptLine (immutable — never updated)
-- ─────────────────────────────────────────────────────────────

CREATE TABLE "InventoryReceiptLine" (
    "id"               TEXT NOT NULL,
    "tenantId"         TEXT NOT NULL,
    "receiptId"        TEXT NOT NULL,
    "productId"        TEXT NOT NULL,
    "productVariantId" TEXT,
    "quantityReceived" DECIMAL(12,3) NOT NULL,
    "unitCost"         DECIMAL(12,2) NOT NULL,
    "lotNumber"        TEXT,
    "expiryDate"       TIMESTAMP(3),
    "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InventoryReceiptLine_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "InventoryReceiptLine_tenantId_idx"
    ON "InventoryReceiptLine"("tenantId");
CREATE INDEX "InventoryReceiptLine_receiptId_idx"
    ON "InventoryReceiptLine"("receiptId");
CREATE INDEX "InventoryReceiptLine_productId_idx"
    ON "InventoryReceiptLine"("productId");
CREATE INDEX "InventoryReceiptLine_productVariantId_idx"
    ON "InventoryReceiptLine"("productVariantId");
CREATE INDEX "InventoryReceiptLine_productId_productVariantId_createdAt_idx"
    ON "InventoryReceiptLine"("productId", "productVariantId", "createdAt");

ALTER TABLE "InventoryReceiptLine"
    ADD CONSTRAINT "InventoryReceiptLine_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InventoryReceiptLine"
    ADD CONSTRAINT "InventoryReceiptLine_receiptId_fkey"
    FOREIGN KEY ("receiptId") REFERENCES "InventoryReceipt"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InventoryReceiptLine"
    ADD CONSTRAINT "InventoryReceiptLine_productId_fkey"
    FOREIGN KEY ("productId") REFERENCES "Product"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InventoryReceiptLine"
    ADD CONSTRAINT "InventoryReceiptLine_productVariantId_fkey"
    FOREIGN KEY ("productVariantId") REFERENCES "ProductVariant"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
