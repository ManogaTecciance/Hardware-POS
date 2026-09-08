-- D67 — per-user printer choices (PO request, 2026-08-18).
--
-- A waiter works from a tablet that is on the shop network but wired to
-- nothing; WHICH kitchen/cashier printer their orders print on is a
-- per-person setting layered over the branch routing. Purely additive: a
-- user with no row keeps the branch behaviour exactly. Both printer columns
-- are ON DELETE SET NULL so removing a printer degrades a preference to
-- "use the branch default" instead of blocking the delete. (The recurring
-- D44 InventoryReceiptLine FK drift pair is stripped, as always.)

-- CreateTable
CREATE TABLE "UserPrinterPreference" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kitchenPrinterId" TEXT,
    "cashierPrinterId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserPrinterPreference_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UserPrinterPreference_userId_key" ON "UserPrinterPreference"("userId");

-- CreateIndex
CREATE INDEX "UserPrinterPreference_tenantId_idx" ON "UserPrinterPreference"("tenantId");

-- AddForeignKey
ALTER TABLE "UserPrinterPreference" ADD CONSTRAINT "UserPrinterPreference_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserPrinterPreference" ADD CONSTRAINT "UserPrinterPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserPrinterPreference" ADD CONSTRAINT "UserPrinterPreference_kitchenPrinterId_fkey" FOREIGN KEY ("kitchenPrinterId") REFERENCES "KitchenPrinter"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserPrinterPreference" ADD CONSTRAINT "UserPrinterPreference_cashierPrinterId_fkey" FOREIGN KEY ("cashierPrinterId") REFERENCES "KitchenPrinter"("id") ON DELETE SET NULL ON UPDATE CASCADE;
