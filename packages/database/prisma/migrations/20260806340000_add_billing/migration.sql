-- Phase 8 — Billing (D8). Additive:
--   * Four new Sale columns (service charge, packaging, billing version,
--     close idempotency key). Every column has a default; existing rows
--     get 0 / 1 / null and behave exactly as before.
--   * BillSplit table for split billing (one Sale, many claims).

-- AlterTable
ALTER TABLE "Sale" ADD COLUMN     "billingVersion" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "closeIdempotencyKey" TEXT,
ADD COLUMN     "packagingCharge" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "serviceChargeAmount" DECIMAL(12,2) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "BillSplit" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "label" TEXT,
    "share" DECIMAL(12,2) NOT NULL,
    "paidAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillSplit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BillSplit_tenantId_idx" ON "BillSplit"("tenantId");

-- CreateIndex
CREATE INDEX "BillSplit_saleId_idx" ON "BillSplit"("saleId");

-- AddForeignKey
ALTER TABLE "BillSplit" ADD CONSTRAINT "BillSplit_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillSplit" ADD CONSTRAINT "BillSplit_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "Sale"("id") ON DELETE CASCADE ON UPDATE CASCADE;

