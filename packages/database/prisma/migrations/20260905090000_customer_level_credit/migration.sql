-- Credit becomes an ACCOUNT balance rather than a per-invoice one.
--
-- A payment is now either tendered at the till against a sale, or received
-- against a customer's credit account. Exactly one of the two, enforced below:
-- a row with both would be counted twice, and a row with neither is money
-- belonging to nobody.

-- AlterTable: Payment
ALTER TABLE "Payment" ALTER COLUMN "saleId" DROP NOT NULL;
ALTER TABLE "Payment" ADD COLUMN     "customerId" TEXT;
ALTER TABLE "Payment" ADD COLUMN     "settledAt" TIMESTAMP(3);

-- Every existing row is a till payment, so customerId stays NULL: no backfill.
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_sale_xor_customer"
  CHECK (num_nonnulls("saleId", "customerId") = 1);

-- The sale FK becomes optional. Re-created rather than altered because the
-- column's nullability changed underneath it.
ALTER TABLE "Payment" DROP CONSTRAINT "Payment_saleId_fkey";
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_saleId_fkey"
  FOREIGN KEY ("saleId") REFERENCES "Sale"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RESTRICT: deleting a customer must not quietly detach the money that settled
-- their account, nor leave a row that satisfies neither side of the CHECK.
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_customerId_fkey"
  FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "Payment_tenantId_customerId_createdAt_idx" ON "Payment"("tenantId", "customerId", "createdAt");

-- AlterTable: Sale
-- Records that an account settlement covered this invoice. Deliberately NOT a
-- rewrite of paidAmount/balanceAmount, which stay true to what was tendered
-- against this invoice at the till.
ALTER TABLE "Sale" ADD COLUMN     "creditSettledAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Sale_tenantId_customerId_creditSettledAt_idx" ON "Sale"("tenantId", "customerId", "creditSettledAt");
