-- POS Product Variations in the Customise dialog (D46). Additive per D15.
--
-- Unblocks the last piece D45 deferred: sending Product-sourced round items
-- to the kitchen. Restaurant tenants can already create Products with
-- variants in the wizard (D44) and see them in the POS catalogue endpoint
-- (D45's `/restaurant/pos-catalogue`), but the round-submission path was
-- still MenuItem-only. This migration lands the snapshot columns +
-- discriminator that `submitRound` needs to accept a Product+Variant
-- round item.
--
-- Snapshot discipline mirrors the existing MenuItem snapshot pattern on
-- `RestaurantOrderItem` (menuItemName / unitPrice / modifierTotal are
-- frozen at submit): the variant's name and price at submit time are
-- captured too, so a later variant rename or price change cannot rewrite
-- historical orders / KOTs / bills / receipts.
--
-- Nothing existing is altered. `menuItemId` stays a loose string reference
-- with its snapshots intact. Sale-close (`table-sessions.service.
-- closeSession`) already reads only from snapshot columns, so it is
-- source-agnostic — no schema change needed there.

-- ─────────────────────────────────────────────────────────────
-- Enum — source discriminator on RestaurantOrderItem
-- ─────────────────────────────────────────────────────────────

CREATE TYPE "RestaurantOrderItemSourceKind" AS ENUM ('MENU_ITEM', 'PRODUCT');

-- ─────────────────────────────────────────────────────────────
-- RestaurantOrderItem — sourceKind + Product+Variant + snapshots
-- ─────────────────────────────────────────────────────────────
--
-- `sourceKind` defaults to `MENU_ITEM` so every legacy row keeps the same
-- semantics; only new PRODUCT-sourced writes carry the new value. The
-- backend's `submitRound` widening keys off this column to pick the right
-- resolver (MenuItem lookup vs Product+Variant lookup).
--
-- `productId` / `productVariantId` are nullable — a MENU_ITEM row leaves
-- both NULL. `productVariantId` is nullable even for a PRODUCT row because
-- a non-variant Product (hasVariants=false) sells at the parent price and
-- has no variant reference.
--
-- `variantNameSnapshot` / `variantPriceSnapshot` are the immutable
-- reconstruction fields. `variantPriceSnapshot` uses Decimal(12,2) to
-- match `RestaurantOrderItem.unitPrice`'s scale.

ALTER TABLE "RestaurantOrderItem"
    ADD COLUMN "sourceKind" "RestaurantOrderItemSourceKind" NOT NULL DEFAULT 'MENU_ITEM',
    ADD COLUMN "productId" TEXT,
    ADD COLUMN "productVariantId" TEXT,
    ADD COLUMN "variantNameSnapshot" TEXT,
    ADD COLUMN "variantPriceSnapshot" DECIMAL(12,2);

CREATE INDEX "RestaurantOrderItem_productId_idx"
    ON "RestaurantOrderItem"("productId");
CREATE INDEX "RestaurantOrderItem_productVariantId_idx"
    ON "RestaurantOrderItem"("productVariantId");
CREATE INDEX "RestaurantOrderItem_sourceKind_idx"
    ON "RestaurantOrderItem"("sourceKind");

-- FK is ON DELETE SET NULL so a Product deletion never cascades into
-- historical order rows. Snapshots preserve the display fields.
ALTER TABLE "RestaurantOrderItem"
    ADD CONSTRAINT "RestaurantOrderItem_productId_fkey"
    FOREIGN KEY ("productId") REFERENCES "Product"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "RestaurantOrderItem"
    ADD CONSTRAINT "RestaurantOrderItem_productVariantId_fkey"
    FOREIGN KEY ("productVariantId") REFERENCES "ProductVariant"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────
-- KitchenTicketItem — variant name for the printed KOT
-- ─────────────────────────────────────────────────────────────
--
-- The kitchen must see the variant selection on the ticket ("MEDIUM",
-- "LARGE") — inferring it from selling price is a footgun the brief
-- explicitly forbids. Nullable so legacy tickets (no variant selection)
-- render unchanged.

ALTER TABLE "KitchenTicketItem"
    ADD COLUMN "variantName" TEXT;
