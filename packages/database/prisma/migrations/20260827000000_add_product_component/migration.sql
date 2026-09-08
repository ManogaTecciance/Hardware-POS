-- D65 — ProductComponent: recipes / bill-of-materials for composed sellables
-- (convergence plan §8.8, Phase 8). ONE level, no recursion. Purely additive:
-- no existing table is touched, so a tenant that authors no recipes sees no
-- behaviour change. (The recurring D44 InventoryReceiptLine FK drift pair
-- emitted by `migrate diff` is stripped, as in every migration since.)

-- CreateTable
CREATE TABLE "ProductComponent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "productVariantId" TEXT,
    "componentProductId" TEXT NOT NULL,
    "componentVariantId" TEXT,
    "quantity" DECIMAL(12,4) NOT NULL,
    "unit" TEXT,
    "wastageRate" DECIMAL(5,4) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductComponent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProductComponent_tenantId_idx" ON "ProductComponent"("tenantId");

-- CreateIndex
CREATE INDEX "ProductComponent_componentProductId_idx" ON "ProductComponent"("componentProductId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductComponent_productId_productVariantId_componentProduc_key" ON "ProductComponent"("productId", "productVariantId", "componentProductId", "componentVariantId");

-- AddForeignKey
ALTER TABLE "ProductComponent" ADD CONSTRAINT "ProductComponent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductComponent" ADD CONSTRAINT "ProductComponent_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductComponent" ADD CONSTRAINT "ProductComponent_componentProductId_fkey" FOREIGN KEY ("componentProductId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
