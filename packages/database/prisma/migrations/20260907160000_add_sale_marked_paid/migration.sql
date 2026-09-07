-- Ticking a credit invoice off on the customer's page.
--
-- A bookkeeping note only: it records who and when, moves no money, and leaves
-- balanceAmount, paymentStatus and the credit aggregation alone. What the
-- customer owes still comes from recorded payments.

-- AlterTable
ALTER TABLE "Sale" ADD COLUMN     "markedPaidAt" TIMESTAMP(3);
ALTER TABLE "Sale" ADD COLUMN     "markedPaidByUserId" TEXT;

-- AddForeignKey
-- SET NULL, matching how a Sale keeps its cashier reference: losing the user
-- must not erase the fact that the invoice was ticked off.
ALTER TABLE "Sale" ADD CONSTRAINT "Sale_markedPaidByUserId_fkey"
  FOREIGN KEY ("markedPaidByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex
-- The customer page lists a customer's invoices newest-first.
CREATE INDEX "Sale_tenantId_customerId_completedAt_idx" ON "Sale"("tenantId", "customerId", "completedAt");
