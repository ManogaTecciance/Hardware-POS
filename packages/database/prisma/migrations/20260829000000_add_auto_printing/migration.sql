-- D67 — auto-printing: KOTs on the station printers at round submit, the
-- finalised bill on the branch's CASHIER printer at close/handover.
--
-- Purely additive. Every column is defaulted or nullable, so existing rows
-- keep their exact meaning: printers backfill to role KITCHEN (their only
-- current use) at 48 columns (80 mm, the pilot's paper), branches get the
-- switches ON but with NO cashier printer configured — which enqueues
-- nothing that can print until an operator assigns one. (The recurring D44
-- InventoryReceiptLine FK drift pair emitted by `migrate diff` is stripped,
-- as in every migration since.)

-- CreateEnum
CREATE TYPE "PrinterRole" AS ENUM ('KITCHEN', 'CASHIER');

-- AlterEnum
ALTER TYPE "PrintJobType" ADD VALUE 'ORDER_BILL';

-- AlterTable
ALTER TABLE "KitchenPrinter" ADD COLUMN     "columns" INTEGER NOT NULL DEFAULT 48,
ADD COLUMN     "role" "PrinterRole" NOT NULL DEFAULT 'KITCHEN';

-- AlterTable
ALTER TABLE "PrintJob" ADD COLUMN     "attemptCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "branchId" TEXT,
ADD COLUMN     "lastError" TEXT,
ADD COLUMN     "printerId" TEXT;

-- AlterTable
ALTER TABLE "RestaurantBranchConfig" ADD COLUMN     "autoPrintBill" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "autoPrintKot" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "billCopies" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "defaultReceiptPrinterId" TEXT;

-- CreateIndex
CREATE INDEX "PrintJob_branchId_idx" ON "PrintJob"("branchId");
