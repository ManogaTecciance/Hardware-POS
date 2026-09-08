-- Phase 6 (D6, scenario 20). KOTs, printers, and the retry ledger.
-- Additive: KitchenPrinter, KitchenTicket, KitchenTicketItem, and the
-- KitchenPrintAttempt row per try. Nothing existing is altered.

-- CreateEnum
CREATE TYPE "KitchenPrinterKind" AS ENUM ('ESC_POS_NETWORK', 'ESC_POS_USB', 'A4_NETWORK', 'MOCK');

-- CreateEnum
CREATE TYPE "KitchenTicketStatus" AS ENUM ('QUEUED', 'PRINTED', 'REPRINTED', 'FAILED');

-- CreateEnum
CREATE TYPE "KitchenPrintAttemptStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED');

-- CreateTable
CREATE TABLE "KitchenPrinter" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "KitchenPrinterKind" NOT NULL,
    "address" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KitchenPrinter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KitchenTicket" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "roundId" TEXT NOT NULL,
    "stationId" TEXT NOT NULL,
    "primaryPrinterId" TEXT,
    "ticketNumber" TEXT NOT NULL,
    "status" "KitchenTicketStatus" NOT NULL DEFAULT 'QUEUED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KitchenTicket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KitchenTicketItem" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "menuItemName" TEXT NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL,
    "modifierNames" TEXT[],
    "specialInstructions" TEXT,

    CONSTRAINT "KitchenTicketItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KitchenPrintAttempt" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "printerId" TEXT NOT NULL,
    "status" "KitchenPrintAttemptStatus" NOT NULL DEFAULT 'PENDING',
    "error" TEXT,
    "attemptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "KitchenPrintAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "KitchenPrinter_tenantId_idx" ON "KitchenPrinter"("tenantId");

-- CreateIndex
CREATE INDEX "KitchenPrinter_branchId_idx" ON "KitchenPrinter"("branchId");

-- CreateIndex
CREATE UNIQUE INDEX "KitchenPrinter_branchId_code_key" ON "KitchenPrinter"("branchId", "code");

-- CreateIndex
CREATE INDEX "KitchenTicket_tenantId_idx" ON "KitchenTicket"("tenantId");

-- CreateIndex
CREATE INDEX "KitchenTicket_branchId_idx" ON "KitchenTicket"("branchId");

-- CreateIndex
CREATE INDEX "KitchenTicket_roundId_idx" ON "KitchenTicket"("roundId");

-- CreateIndex
CREATE INDEX "KitchenTicket_stationId_idx" ON "KitchenTicket"("stationId");

-- CreateIndex
CREATE INDEX "KitchenTicket_status_idx" ON "KitchenTicket"("status");

-- CreateIndex
CREATE UNIQUE INDEX "KitchenTicket_tenantId_ticketNumber_key" ON "KitchenTicket"("tenantId", "ticketNumber");

-- CreateIndex
CREATE INDEX "KitchenTicketItem_tenantId_idx" ON "KitchenTicketItem"("tenantId");

-- CreateIndex
CREATE INDEX "KitchenTicketItem_ticketId_idx" ON "KitchenTicketItem"("ticketId");

-- CreateIndex
CREATE INDEX "KitchenPrintAttempt_tenantId_idx" ON "KitchenPrintAttempt"("tenantId");

-- CreateIndex
CREATE INDEX "KitchenPrintAttempt_ticketId_idx" ON "KitchenPrintAttempt"("ticketId");

-- CreateIndex
CREATE INDEX "KitchenPrintAttempt_printerId_idx" ON "KitchenPrintAttempt"("printerId");

-- CreateIndex
CREATE INDEX "KitchenPrintAttempt_status_idx" ON "KitchenPrintAttempt"("status");

-- AddForeignKey
ALTER TABLE "KitchenPrinter" ADD CONSTRAINT "KitchenPrinter_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KitchenPrinter" ADD CONSTRAINT "KitchenPrinter_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KitchenTicket" ADD CONSTRAINT "KitchenTicket_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KitchenTicket" ADD CONSTRAINT "KitchenTicket_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KitchenTicket" ADD CONSTRAINT "KitchenTicket_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "OrderRound"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KitchenTicket" ADD CONSTRAINT "KitchenTicket_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "KitchenStation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KitchenTicket" ADD CONSTRAINT "KitchenTicket_primaryPrinterId_fkey" FOREIGN KEY ("primaryPrinterId") REFERENCES "KitchenPrinter"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KitchenTicketItem" ADD CONSTRAINT "KitchenTicketItem_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "KitchenTicket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KitchenTicketItem" ADD CONSTRAINT "KitchenTicketItem_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KitchenPrintAttempt" ADD CONSTRAINT "KitchenPrintAttempt_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KitchenPrintAttempt" ADD CONSTRAINT "KitchenPrintAttempt_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "KitchenTicket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KitchenPrintAttempt" ADD CONSTRAINT "KitchenPrintAttempt_printerId_fkey" FOREIGN KEY ("printerId") REFERENCES "KitchenPrinter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

