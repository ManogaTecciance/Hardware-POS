-- D58 — the settlement document is universal (convergence plan Phase 1).
--
-- Additive except for two deliberate widenings, both scoped by the
-- per-migration proof in provider-contract.spec.ts:
--   • SaleItem.productId DROP NOT NULL — a line projected from a legacy
--     MenuItem has no Product; the name/price snapshots carry the document.
--   • The SaleItem_productId_fkey is re-created ON DELETE SET NULL to match
--     the now-optional relation, so a product deletion can never cascade into
--     (or be blocked by) settled financial history.
-- Every default is chosen so existing retail rows keep their exact meaning:
-- sourceKind RETAIL_CART, channel COUNTER, fulfilmentKind IMMEDIATE.

-- CreateEnum
CREATE TYPE "FulfilmentKind" AS ENUM ('IMMEDIATE', 'TABLE_SERVICE');

-- CreateEnum
CREATE TYPE "OrderChannel" AS ENUM ('COUNTER', 'DINE_IN', 'TAKEAWAY', 'ONLINE');

-- CreateEnum
CREATE TYPE "SaleItemSourceKind" AS ENUM ('RETAIL_CART', 'RESTAURANT_ORDER_ITEM');

-- DropForeignKey
ALTER TABLE "SaleItem" DROP CONSTRAINT "SaleItem_productId_fkey";

-- AlterTable
ALTER TABLE "Sale" ADD COLUMN     "channel" "OrderChannel" NOT NULL DEFAULT 'COUNTER',
ADD COLUMN     "fulfilmentKind" "FulfilmentKind" NOT NULL DEFAULT 'IMMEDIATE',
ADD COLUMN     "servedByUserId" TEXT,
ADD COLUMN     "sourceRefId" TEXT,
ADD COLUMN     "sourceRefKind" TEXT;

-- AlterTable
ALTER TABLE "SaleItem" ADD COLUMN     "backfilledAt" TIMESTAMP(3),
ADD COLUMN     "modifierTotal" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "notes" TEXT,
ADD COLUMN     "sourceItemId" TEXT,
ADD COLUMN     "sourceKind" "SaleItemSourceKind" NOT NULL DEFAULT 'RETAIL_CART',
ALTER COLUMN "productId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "SaleItemModifier" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "saleItemId" TEXT NOT NULL,
    "modifierOptionId" TEXT,
    "optionName" TEXT NOT NULL,
    "groupName" TEXT NOT NULL,
    "priceDelta" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SaleItemModifier_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SaleItemModifier_tenantId_idx" ON "SaleItemModifier"("tenantId");

-- CreateIndex
CREATE INDEX "SaleItemModifier_saleItemId_idx" ON "SaleItemModifier"("saleItemId");

-- CreateIndex
CREATE INDEX "Sale_channel_idx" ON "Sale"("channel");

-- CreateIndex
CREATE INDEX "Sale_tenantId_completedAt_idx" ON "Sale"("tenantId", "completedAt");

-- CreateIndex
CREATE INDEX "SaleItem_sourceKind_sourceItemId_idx" ON "SaleItem"("sourceKind", "sourceItemId");

-- AddForeignKey
ALTER TABLE "SaleItem" ADD CONSTRAINT "SaleItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaleItemModifier" ADD CONSTRAINT "SaleItemModifier_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaleItemModifier" ADD CONSTRAINT "SaleItemModifier_saleItemId_fkey" FOREIGN KEY ("saleItemId") REFERENCES "SaleItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
