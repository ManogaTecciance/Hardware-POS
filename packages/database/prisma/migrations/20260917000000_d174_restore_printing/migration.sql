-- D174 — the kitchen prints again, and the board is what makes that safe.
--
-- Restores the columns and tables D68 dropped in
-- `20260903000000_kitchen_ticket_completion`, so that unattended printing has
-- somewhere to keep its state again. Everything the board gained in between
-- stays: `KitchenTicket.completedAt`/`completedByUserId` and the
-- IN_PROGRESS/COMPLETED statuses are untouched, because print state now lives
-- ENTIRELY on `KitchenPrintAttempt` and never writes back to the ticket. That
-- separation is the schema half of D174's safety condition — a printer cannot
-- move a ticket on the board.
--
-- `UserPrinterPreference` is deliberately NOT restored. D67 needed it because
-- routing had no dependable answer for which printer a dish belonged to; D152
-- gave the station that answer, and a per-person override would now contradict
-- it (a grill dish belongs on the grill printer regardless of who keyed it in).
--
-- Additive only (D15): every statement adds a type, table, column or index.
-- Nothing is dropped, and no existing row changes meaning — a deployment that
-- has not configured a printer enqueues nothing and behaves exactly as before.
-- (The recurring D44 InventoryReceiptLine FK drift pair is stripped, as always.)

-- AlterEnum
-- IF NOT EXISTS keeps a re-run harmless, per D113's precedent.
ALTER TYPE "PrintJobType" ADD VALUE IF NOT EXISTS 'ORDER_BILL';
ALTER TYPE "PrintJobType" ADD VALUE IF NOT EXISTS 'PRINTER_TEST';

-- CreateEnum
CREATE TYPE "PrinterRole" AS ENUM ('KITCHEN', 'CASHIER');

-- AlterTable
-- Existing rows backfill to KITCHEN and 48 columns: station-routed KOTs on
-- 80 mm paper is the only thing this registry has ever been used for.
ALTER TABLE "KitchenPrinter" ADD COLUMN     "role" "PrinterRole" NOT NULL DEFAULT 'KITCHEN',
ADD COLUMN     "columns" INTEGER NOT NULL DEFAULT 48;

-- AlterTable
ALTER TABLE "KitchenPrintAttempt" ADD COLUMN     "leaseId" TEXT,
ADD COLUMN     "leasedAt" TIMESTAMP(3),
ADD COLUMN     "leasedBy" TEXT;

-- AlterTable
ALTER TABLE "PrintJob" ADD COLUMN     "branchId" TEXT,
ADD COLUMN     "orderId" TEXT,
ADD COLUMN     "printerId" TEXT,
ADD COLUMN     "attemptCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lastError" TEXT,
ADD COLUMN     "leaseId" TEXT,
ADD COLUMN     "leasedAt" TIMESTAMP(3),
ADD COLUMN     "leasedBy" TEXT;

-- AlterTable
ALTER TABLE "RestaurantBranchConfig" ADD COLUMN     "autoPrintKot" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "autoPrintBill" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "billCopies" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "defaultReceiptPrinterId" TEXT,
ADD COLUMN     "defaultKitchenPrinterId" TEXT;

-- CreateTable
CREATE TABLE "PrintAgent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastSeenAt" TIMESTAMP(3),
    "version" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PrintAgent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PrintAgent_tokenHash_key" ON "PrintAgent"("tokenHash");

-- CreateIndex
CREATE INDEX "PrintAgent_tenantId_idx" ON "PrintAgent"("tenantId");

-- CreateIndex
CREATE INDEX "PrintAgent_branchId_idx" ON "PrintAgent"("branchId");

-- CreateIndex
CREATE INDEX "PrintJob_branchId_idx" ON "PrintJob"("branchId");

-- CreateIndex
CREATE INDEX "PrintJob_orderId_idx" ON "PrintJob"("orderId");

-- AddForeignKey
ALTER TABLE "PrintAgent" ADD CONSTRAINT "PrintAgent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrintAgent" ADD CONSTRAINT "PrintAgent_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrintJob" ADD CONSTRAINT "PrintJob_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "RestaurantOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
