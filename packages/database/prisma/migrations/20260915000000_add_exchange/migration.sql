-- D107 — an exchange links a return to a sale (Phase 7, step 7.1a).
--
-- Additive: one new table. No existing table, column or row is touched. Nothing
-- is backfilled, because there are no exchanges to backfill — the transaction
-- has never existed.
--
-- Why `replacementSaleId` is nullable: the return leg commits first, so there is
-- a real interval in which an exchange exists with no replacement. A NOT NULL
-- column would make the row unwritable until both legs succeeded, which destroys
-- the recoverable state D107 chose — if the sale fails, the customer holds store
-- credit worth what they handed back and the operator retries.
--
-- Deliberately NOT `CREATE ... IF NOT EXISTS`. D104c: `IF NOT EXISTS` keys on the
-- NAME, so it silently accepts a different object that happens to share one, and
-- converts "this exists, differently" into "fine". A name collision should fail
-- loudly here, which is the cheapest place to find it.

-- CreateTable
CREATE TABLE "Exchange" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "exchangeNumber" TEXT NOT NULL,
    "originalSaleId" TEXT NOT NULL,
    "returnId" TEXT NOT NULL,
    "replacementSaleId" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Exchange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Exchange_tenantId_idx" ON "Exchange"("tenantId");

-- CreateIndex
CREATE INDEX "Exchange_branchId_idx" ON "Exchange"("branchId");

-- CreateIndex
CREATE INDEX "Exchange_originalSaleId_idx" ON "Exchange"("originalSaleId");

-- CreateIndex
CREATE INDEX "Exchange_replacementSaleId_idx" ON "Exchange"("replacementSaleId");

-- CreateIndex
CREATE UNIQUE INDEX "Exchange_tenantId_exchangeNumber_key" ON "Exchange"("tenantId", "exchangeNumber");

-- CreateIndex
-- A replayed request must return the existing exchange rather than refund twice.
CREATE UNIQUE INDEX "Exchange_tenantId_idempotencyKey_key" ON "Exchange"("tenantId", "idempotencyKey");

-- CreateIndex
-- One exchange per return: the returning leg is what makes the exchange exist,
-- so two exchanges sharing it would mean the same goods came back twice.
CREATE UNIQUE INDEX "Exchange_returnId_key" ON "Exchange"("returnId");

-- AddForeignKey
ALTER TABLE "Exchange" ADD CONSTRAINT "Exchange_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Exchange" ADD CONSTRAINT "Exchange_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Exchange" ADD CONSTRAINT "Exchange_originalSaleId_fkey" FOREIGN KEY ("originalSaleId") REFERENCES "Sale"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Exchange" ADD CONSTRAINT "Exchange_returnId_fkey" FOREIGN KEY ("returnId") REFERENCES "Return"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Exchange" ADD CONSTRAINT "Exchange_replacementSaleId_fkey" FOREIGN KEY ("replacementSaleId") REFERENCES "Sale"("id") ON DELETE SET NULL ON UPDATE CASCADE;
