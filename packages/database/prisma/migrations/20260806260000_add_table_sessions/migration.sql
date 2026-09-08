-- Restaurant Phase 2D. Additive: five enums plus the operational core.
--
-- TableSession is one seating. RestaurantOrder is the per-session order
-- book. OrderRound is the immutable slice of items sent in one submit
-- (idempotent per key). RestaurantOrderItem carries the price/name
-- snapshot at send-to-kitchen time (AD-15). RestaurantOrderStatusHistory
-- is append-only for audit.
--
-- The junction to Sale is a nullable @unique FK on TableSession.finalSaleId,
-- matching the Quotation.convertedSaleId double-close guard: a session that
-- has produced a Sale is unique to that Sale row.

-- CreateEnum
CREATE TYPE "RestaurantOrderChannel" AS ENUM ('DINE_IN', 'TAKEAWAY', 'ONLINE');

-- CreateEnum
CREATE TYPE "TableSessionStatus" AS ENUM ('OPEN', 'BILLING', 'CLOSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "RestaurantOrderStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'PARTIAL', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "OrderRoundStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'IN_PROGRESS', 'READY', 'DELIVERED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "RestaurantOrderItemStatus" AS ENUM ('PENDING', 'SENT', 'IN_PROGRESS', 'READY', 'DELIVERED', 'VOIDED');

-- CreateTable
CREATE TABLE "TableSession" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "tableId" TEXT NOT NULL,
    "sessionNumber" TEXT NOT NULL,
    "status" "TableSessionStatus" NOT NULL DEFAULT 'OPEN',
    "waiterUserId" TEXT,
    "guestCount" INTEGER,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),
    "finalSaleId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TableSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RestaurantOrder" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "orderNumber" TEXT NOT NULL,
    "channel" "RestaurantOrderChannel" NOT NULL DEFAULT 'DINE_IN',
    "status" "RestaurantOrderStatus" NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RestaurantOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderRound" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "roundNumber" INTEGER NOT NULL,
    "submittedAt" TIMESTAMP(3),
    "submittedByUserId" TEXT,
    "status" "OrderRoundStatus" NOT NULL DEFAULT 'DRAFT',
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderRound_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RestaurantOrderItem" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "roundId" TEXT NOT NULL,
    "menuItemId" TEXT NOT NULL,
    "menuItemName" TEXT NOT NULL,
    "menuItemCode" TEXT,
    "unitPrice" DECIMAL(12,2) NOT NULL,
    "modifierTotal" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "quantity" DECIMAL(12,3) NOT NULL DEFAULT 1,
    "specialInstructions" TEXT,
    "status" "RestaurantOrderItemStatus" NOT NULL DEFAULT 'PENDING',
    "voidReason" TEXT,
    "voidedByUserId" TEXT,
    "voidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RestaurantOrderItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RestaurantOrderItemModifier" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "modifierOptionId" TEXT NOT NULL,
    "optionName" TEXT NOT NULL,
    "groupName" TEXT NOT NULL,
    "priceDelta" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RestaurantOrderItemModifier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RestaurantOrderStatusHistory" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "fromStatus" "RestaurantOrderStatus",
    "toStatus" "RestaurantOrderStatus" NOT NULL,
    "reason" TEXT,
    "changedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RestaurantOrderStatusHistory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TableSession_finalSaleId_key" ON "TableSession"("finalSaleId");

-- CreateIndex
CREATE INDEX "TableSession_tenantId_idx" ON "TableSession"("tenantId");

-- CreateIndex
CREATE INDEX "TableSession_branchId_idx" ON "TableSession"("branchId");

-- CreateIndex
CREATE INDEX "TableSession_tableId_idx" ON "TableSession"("tableId");

-- CreateIndex
CREATE INDEX "TableSession_status_idx" ON "TableSession"("status");

-- CreateIndex
CREATE UNIQUE INDEX "TableSession_tenantId_sessionNumber_key" ON "TableSession"("tenantId", "sessionNumber");

-- CreateIndex
CREATE INDEX "RestaurantOrder_tenantId_idx" ON "RestaurantOrder"("tenantId");

-- CreateIndex
CREATE INDEX "RestaurantOrder_branchId_idx" ON "RestaurantOrder"("branchId");

-- CreateIndex
CREATE INDEX "RestaurantOrder_sessionId_idx" ON "RestaurantOrder"("sessionId");

-- CreateIndex
CREATE INDEX "RestaurantOrder_status_idx" ON "RestaurantOrder"("status");

-- CreateIndex
CREATE UNIQUE INDEX "RestaurantOrder_tenantId_orderNumber_key" ON "RestaurantOrder"("tenantId", "orderNumber");

-- CreateIndex
CREATE INDEX "OrderRound_tenantId_idx" ON "OrderRound"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "OrderRound_orderId_roundNumber_key" ON "OrderRound"("orderId", "roundNumber");

-- CreateIndex
CREATE UNIQUE INDEX "OrderRound_tenantId_idempotencyKey_key" ON "OrderRound"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "RestaurantOrderItem_tenantId_idx" ON "RestaurantOrderItem"("tenantId");

-- CreateIndex
CREATE INDEX "RestaurantOrderItem_orderId_idx" ON "RestaurantOrderItem"("orderId");

-- CreateIndex
CREATE INDEX "RestaurantOrderItem_roundId_idx" ON "RestaurantOrderItem"("roundId");

-- CreateIndex
CREATE INDEX "RestaurantOrderItem_menuItemId_idx" ON "RestaurantOrderItem"("menuItemId");

-- CreateIndex
CREATE INDEX "RestaurantOrderItem_status_idx" ON "RestaurantOrderItem"("status");

-- CreateIndex
CREATE INDEX "RestaurantOrderItemModifier_tenantId_idx" ON "RestaurantOrderItemModifier"("tenantId");

-- CreateIndex
CREATE INDEX "RestaurantOrderItemModifier_itemId_idx" ON "RestaurantOrderItemModifier"("itemId");

-- CreateIndex
CREATE INDEX "RestaurantOrderStatusHistory_tenantId_idx" ON "RestaurantOrderStatusHistory"("tenantId");

-- CreateIndex
CREATE INDEX "RestaurantOrderStatusHistory_orderId_idx" ON "RestaurantOrderStatusHistory"("orderId");

-- AddForeignKey
ALTER TABLE "TableSession" ADD CONSTRAINT "TableSession_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TableSession" ADD CONSTRAINT "TableSession_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TableSession" ADD CONSTRAINT "TableSession_tableId_fkey" FOREIGN KEY ("tableId") REFERENCES "RestaurantTable"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RestaurantOrder" ADD CONSTRAINT "RestaurantOrder_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RestaurantOrder" ADD CONSTRAINT "RestaurantOrder_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RestaurantOrder" ADD CONSTRAINT "RestaurantOrder_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "TableSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderRound" ADD CONSTRAINT "OrderRound_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderRound" ADD CONSTRAINT "OrderRound_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "RestaurantOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RestaurantOrderItem" ADD CONSTRAINT "RestaurantOrderItem_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RestaurantOrderItem" ADD CONSTRAINT "RestaurantOrderItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "RestaurantOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RestaurantOrderItem" ADD CONSTRAINT "RestaurantOrderItem_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "OrderRound"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RestaurantOrderItemModifier" ADD CONSTRAINT "RestaurantOrderItemModifier_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RestaurantOrderItemModifier" ADD CONSTRAINT "RestaurantOrderItemModifier_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "RestaurantOrderItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RestaurantOrderStatusHistory" ADD CONSTRAINT "RestaurantOrderStatusHistory_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

