-- AlterTable
ALTER TABLE "Sale" ADD COLUMN     "paymentDueDate" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Sale_tenantId_paymentDueDate_idx" ON "Sale"("tenantId", "paymentDueDate");
