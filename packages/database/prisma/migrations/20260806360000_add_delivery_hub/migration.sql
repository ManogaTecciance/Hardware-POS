-- CreateEnum
CREATE TYPE "DeliveryPlatformKind" AS ENUM ('MOCK', 'UBER_EATS', 'PICKME_FOOD', 'DOORDASH', 'OTHER');

-- CreateEnum
CREATE TYPE "ExternalOrderStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'IN_KITCHEN', 'READY', 'DELIVERED', 'CANCELLED');

-- CreateTable
CREATE TABLE "DeliveryPlatform" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "kind" "DeliveryPlatformKind" NOT NULL,
    "externalStoreRef" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeliveryPlatform_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExternalOrder" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "platformId" TEXT NOT NULL,
    "externalOrderRef" TEXT NOT NULL,
    "status" "ExternalOrderStatus" NOT NULL DEFAULT 'PENDING',
    "externalTotal" DECIMAL(12,2),
    "restaurantOrderId" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExternalOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExternalOrderEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "externalOrderId" TEXT NOT NULL,
    "fromStatus" "ExternalOrderStatus",
    "toStatus" "ExternalOrderStatus" NOT NULL,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExternalOrderEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookDeliveryLog" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "branchId" TEXT,
    "platformId" TEXT,
    "payload" JSONB NOT NULL,
    "responseStatus" INTEGER NOT NULL,
    "message" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookDeliveryLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DeliveryPlatform_tenantId_idx" ON "DeliveryPlatform"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryPlatform_branchId_kind_key" ON "DeliveryPlatform"("branchId", "kind");

-- CreateIndex
CREATE INDEX "ExternalOrder_tenantId_idx" ON "ExternalOrder"("tenantId");

-- CreateIndex
CREATE INDEX "ExternalOrder_branchId_idx" ON "ExternalOrder"("branchId");

-- CreateIndex
CREATE INDEX "ExternalOrder_status_idx" ON "ExternalOrder"("status");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalOrder_platformId_externalOrderRef_key" ON "ExternalOrder"("platformId", "externalOrderRef");

-- CreateIndex
CREATE INDEX "ExternalOrderEvent_tenantId_idx" ON "ExternalOrderEvent"("tenantId");

-- CreateIndex
CREATE INDEX "ExternalOrderEvent_externalOrderId_idx" ON "ExternalOrderEvent"("externalOrderId");

-- CreateIndex
CREATE INDEX "WebhookDeliveryLog_tenantId_idx" ON "WebhookDeliveryLog"("tenantId");

-- CreateIndex
CREATE INDEX "WebhookDeliveryLog_branchId_idx" ON "WebhookDeliveryLog"("branchId");

-- CreateIndex
CREATE INDEX "WebhookDeliveryLog_platformId_idx" ON "WebhookDeliveryLog"("platformId");

-- AddForeignKey
ALTER TABLE "DeliveryPlatform" ADD CONSTRAINT "DeliveryPlatform_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryPlatform" ADD CONSTRAINT "DeliveryPlatform_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalOrder" ADD CONSTRAINT "ExternalOrder_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalOrder" ADD CONSTRAINT "ExternalOrder_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalOrder" ADD CONSTRAINT "ExternalOrder_platformId_fkey" FOREIGN KEY ("platformId") REFERENCES "DeliveryPlatform"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalOrderEvent" ADD CONSTRAINT "ExternalOrderEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalOrderEvent" ADD CONSTRAINT "ExternalOrderEvent_externalOrderId_fkey" FOREIGN KEY ("externalOrderId") REFERENCES "ExternalOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookDeliveryLog" ADD CONSTRAINT "WebhookDeliveryLog_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookDeliveryLog" ADD CONSTRAINT "WebhookDeliveryLog_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookDeliveryLog" ADD CONSTRAINT "WebhookDeliveryLog_platformId_fkey" FOREIGN KEY ("platformId") REFERENCES "DeliveryPlatform"("id") ON DELETE SET NULL ON UPDATE CASCADE;

