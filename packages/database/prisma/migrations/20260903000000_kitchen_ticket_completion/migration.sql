-- D68 — the kitchen board replaces kitchen printing.
--
-- Reverses D67's auto-printing schema and adds the one thing the new flow
-- needs: a ticket can be COMPLETED by kitchen staff on the board.
--
-- Forward-only rather than a history rewrite: D67's five migrations are
-- already applied to live development databases, and deleting them would
-- force a reset that wipes seeded workspaces. One drop migration costs a
-- file and no data.

-- D67 wrote bill jobs for takeaway orders that had not settled yet: those
-- rows carry type ORDER_BILL and a NULL saleId, both of which are about to
-- stop existing. They are print queue entries for a feature being removed,
-- so there is nothing to preserve — and leaving them would fail both the
-- enum narrowing and the NOT NULL below.
DELETE FROM "PrintJob" WHERE "type" = 'ORDER_BILL' OR "saleId" IS NULL;

-- AlterEnum
ALTER TYPE "KitchenTicketStatus" ADD VALUE 'COMPLETED';


-- AlterEnum
BEGIN;
CREATE TYPE "PrintJobType_new" AS ENUM ('CUSTOMER_RECEIPT', 'WAREHOUSE_PICKING', 'RETURN_RECEIPT');
ALTER TABLE "PrintJob" ALTER COLUMN "type" TYPE "PrintJobType_new" USING ("type"::text::"PrintJobType_new");
ALTER TYPE "PrintJobType" RENAME TO "PrintJobType_old";
ALTER TYPE "PrintJobType_new" RENAME TO "PrintJobType";
DROP TYPE "public"."PrintJobType_old";
COMMIT;


-- DropForeignKey
ALTER TABLE "PrintAgent" DROP CONSTRAINT "PrintAgent_branchId_fkey";


-- DropForeignKey
ALTER TABLE "PrintAgent" DROP CONSTRAINT "PrintAgent_tenantId_fkey";


-- DropForeignKey
ALTER TABLE "PrintJob" DROP CONSTRAINT "PrintJob_orderId_fkey";


-- DropForeignKey
ALTER TABLE "UserPrinterPreference" DROP CONSTRAINT "UserPrinterPreference_cashierPrinterId_fkey";


-- DropForeignKey
ALTER TABLE "UserPrinterPreference" DROP CONSTRAINT "UserPrinterPreference_kitchenPrinterId_fkey";


-- DropForeignKey
ALTER TABLE "UserPrinterPreference" DROP CONSTRAINT "UserPrinterPreference_tenantId_fkey";


-- DropForeignKey
ALTER TABLE "UserPrinterPreference" DROP CONSTRAINT "UserPrinterPreference_userId_fkey";


-- DropIndex
DROP INDEX "PrintJob_branchId_idx";


-- DropIndex
DROP INDEX "PrintJob_orderId_idx";


-- AlterTable
ALTER TABLE "KitchenPrintAttempt" DROP COLUMN "leaseId",
DROP COLUMN "leasedAt",
DROP COLUMN "leasedBy";


-- AlterTable
ALTER TABLE "KitchenPrinter" DROP COLUMN "columns",
DROP COLUMN "role";


-- AlterTable
ALTER TABLE "KitchenTicket" ADD COLUMN     "completedAt" TIMESTAMP(3),
ADD COLUMN     "completedByUserId" TEXT;


-- AlterTable
ALTER TABLE "PrintJob" DROP COLUMN "attemptCount",
DROP COLUMN "branchId",
DROP COLUMN "lastError",
DROP COLUMN "leaseId",
DROP COLUMN "leasedAt",
DROP COLUMN "leasedBy",
DROP COLUMN "orderId",
DROP COLUMN "printerId",
ALTER COLUMN "saleId" SET NOT NULL;


-- AlterTable
ALTER TABLE "RestaurantBranchConfig" DROP COLUMN "autoPrintBill",
DROP COLUMN "autoPrintKot",
DROP COLUMN "billCopies",
DROP COLUMN "defaultKitchenPrinterId",
DROP COLUMN "defaultReceiptPrinterId";


-- DropTable
DROP TABLE "PrintAgent";


-- DropTable
DROP TABLE "UserPrinterPreference";


-- DropEnum
DROP TYPE "PrinterRole";


-- AddForeignKey
ALTER TABLE "KitchenTicket" ADD CONSTRAINT "KitchenTicket_completedByUserId_fkey" FOREIGN KEY ("completedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

