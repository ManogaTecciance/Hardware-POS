-- D67 — a bill can be printed BEFORE the order settles (PO request,
-- 2026-08-20): a takeaway is taken by the cashier, so both the kitchen
-- ticket and the bill print the moment the order is placed — and at that
-- moment no Sale exists yet (a takeaway's Sale is created on handover). The
-- job therefore points at the RestaurantOrder, and the renderer prices it
-- with the same calculator the close path uses.
--
-- Widening only: `saleId` becomes nullable, so every existing row keeps its
-- exact meaning. (The recurring D44 InventoryReceiptLine FK drift pair is
-- stripped, as always.)

-- AlterTable
ALTER TABLE "PrintJob" ADD COLUMN     "orderId" TEXT,
ALTER COLUMN "saleId" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "PrintJob_orderId_idx" ON "PrintJob"("orderId");

-- AddForeignKey
ALTER TABLE "PrintJob" ADD CONSTRAINT "PrintJob_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "RestaurantOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
