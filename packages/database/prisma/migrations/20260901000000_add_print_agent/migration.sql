-- D67 — the on-site Print Agent (PO constraint, 2026-08-18).
--
-- The web app runs on Amplify and the API on EC2; the printers live on the
-- SHOP's LAN behind NAT, where no cloud process can reach them. A small
-- daemon inside the shop dials OUT over HTTPS and drains the same queue rows
-- the server-side dispatcher drains when the API is itself on-prem. Lease
-- columns let exactly one consumer hold a row while it prints, with a TTL so
-- an agent that dies mid-print releases its work instead of stranding it.
--
-- Additive: no existing row changes meaning, and a deployment with no agent
-- keeps printing directly from the API. (The recurring D44
-- InventoryReceiptLine FK drift pair is stripped, as always.)

-- AlterTable
ALTER TABLE "KitchenPrintAttempt" ADD COLUMN     "leaseId" TEXT,
ADD COLUMN     "leasedAt" TIMESTAMP(3),
ADD COLUMN     "leasedBy" TEXT;

-- AlterTable
ALTER TABLE "PrintJob" ADD COLUMN     "leaseId" TEXT,
ADD COLUMN     "leasedAt" TIMESTAMP(3),
ADD COLUMN     "leasedBy" TEXT;

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

-- AddForeignKey
ALTER TABLE "PrintAgent" ADD CONSTRAINT "PrintAgent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrintAgent" ADD CONSTRAINT "PrintAgent_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
