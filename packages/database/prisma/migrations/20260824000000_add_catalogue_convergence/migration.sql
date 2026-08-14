-- D60 — catalogue convergence (convergence plan Phase 3). Purely additive:
-- the SellableKind enum + defaulted Product column, MenuItem.migratedProductId,
-- and the CatalogueEntry / CatalogueAvailability / CatalogueChannelPrice
-- placement tables. MenuItem and its children are FROZEN by code (writes 410),
-- never touched here.

-- CreateEnum
CREATE TYPE "SellableKind" AS ENUM ('STOCK_ITEM', 'COMPOSED_ITEM', 'SERVICE', 'BUNDLE', 'TIME_SLOT', 'STAY_UNIT');


-- AlterTable
ALTER TABLE "MenuItem" ADD COLUMN     "migratedProductId" TEXT;

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "sellableKind" "SellableKind" NOT NULL DEFAULT 'STOCK_ITEM';

-- CreateTable
CREATE TABLE "CatalogueEntry" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sectionId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "productVariantId" TEXT,
    "priceOverride" DECIMAL(12,2),
    "position" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CatalogueEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CatalogueAvailability" (
    "id" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "dayOfWeek" "MenuAvailabilityDayOfWeek" NOT NULL,
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,

    CONSTRAINT "CatalogueAvailability_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CatalogueChannelPrice" (
    "id" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "price" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "CatalogueChannelPrice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CatalogueEntry_tenantId_idx" ON "CatalogueEntry"("tenantId");

-- CreateIndex
CREATE INDEX "CatalogueEntry_productId_idx" ON "CatalogueEntry"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "CatalogueEntry_sectionId_productId_productVariantId_key" ON "CatalogueEntry"("sectionId", "productId", "productVariantId");

-- CreateIndex
CREATE INDEX "CatalogueAvailability_entryId_idx" ON "CatalogueAvailability"("entryId");

-- CreateIndex
CREATE INDEX "CatalogueChannelPrice_entryId_idx" ON "CatalogueChannelPrice"("entryId");

-- CreateIndex
CREATE UNIQUE INDEX "CatalogueChannelPrice_entryId_channel_key" ON "CatalogueChannelPrice"("entryId", "channel");

-- AddForeignKey
ALTER TABLE "CatalogueEntry" ADD CONSTRAINT "CatalogueEntry_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CatalogueEntry" ADD CONSTRAINT "CatalogueEntry_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "MenuSection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CatalogueEntry" ADD CONSTRAINT "CatalogueEntry_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CatalogueEntry" ADD CONSTRAINT "CatalogueEntry_productVariantId_fkey" FOREIGN KEY ("productVariantId") REFERENCES "ProductVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CatalogueAvailability" ADD CONSTRAINT "CatalogueAvailability_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "CatalogueEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CatalogueChannelPrice" ADD CONSTRAINT "CatalogueChannelPrice_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "CatalogueEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;
