-- D51. Item-level bill splitting: one row per (split, order line) with the
-- portion of that line the split covers. Purely additive — one new table with
-- cascade FKs. A bill with no assignments behaves exactly as it does today.

-- CreateTable
CREATE TABLE "BillSplitItem" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "billSplitId" TEXT NOT NULL,
    "orderItemId" TEXT NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillSplitItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BillSplitItem_tenantId_idx" ON "BillSplitItem"("tenantId");

-- CreateIndex
CREATE INDEX "BillSplitItem_orderItemId_idx" ON "BillSplitItem"("orderItemId");

-- CreateIndex
CREATE UNIQUE INDEX "BillSplitItem_billSplitId_orderItemId_key" ON "BillSplitItem"("billSplitId", "orderItemId");

-- AddForeignKey
ALTER TABLE "BillSplitItem" ADD CONSTRAINT "BillSplitItem_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillSplitItem" ADD CONSTRAINT "BillSplitItem_billSplitId_fkey" FOREIGN KEY ("billSplitId") REFERENCES "BillSplit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillSplitItem" ADD CONSTRAINT "BillSplitItem_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "RestaurantOrderItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

