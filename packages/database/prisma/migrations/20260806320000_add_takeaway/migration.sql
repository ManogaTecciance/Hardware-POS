-- Phase 7 — Takeaway. Additive: one enum + one profile row per takeaway
-- RestaurantOrder. Nothing existing is altered.

-- CreateEnum
CREATE TYPE "TakeawayOrderStatus" AS ENUM ('PLACED', 'IN_KITCHEN', 'READY', 'HANDED_OVER', 'CANCELLED');

-- CreateTable
CREATE TABLE "TakeawayOrderProfile" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "customerName" TEXT,
    "customerPhone" TEXT,
    "pickupAt" TIMESTAMP(3),
    "handoverAt" TIMESTAMP(3),
    "status" "TakeawayOrderStatus" NOT NULL DEFAULT 'PLACED',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TakeawayOrderProfile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TakeawayOrderProfile_orderId_key" ON "TakeawayOrderProfile"("orderId");

-- CreateIndex
CREATE INDEX "TakeawayOrderProfile_tenantId_idx" ON "TakeawayOrderProfile"("tenantId");

-- CreateIndex
CREATE INDEX "TakeawayOrderProfile_status_idx" ON "TakeawayOrderProfile"("status");

-- AddForeignKey
ALTER TABLE "TakeawayOrderProfile" ADD CONSTRAINT "TakeawayOrderProfile_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TakeawayOrderProfile" ADD CONSTRAINT "TakeawayOrderProfile_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "RestaurantOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
