-- Restaurant Phase 2C. Additive: an enum plus DiningArea and the tables
-- physical model. Hardware tenants have zero rows in either.
--
-- The table lifecycle (SEATED / OCCUPIED / BILLING) lives here so a floor
-- plan render is one SELECT. The status-change *history* is deferred to
-- Phase 5 and lands additively on its own migration.

-- CreateEnum
CREATE TYPE "RestaurantTableStatus" AS ENUM ('AVAILABLE', 'SEATED', 'OCCUPIED', 'BILLING', 'CLEANING', 'BLOCKED');

-- CreateTable
CREATE TABLE "DiningArea" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DiningArea_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RestaurantTable" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "areaId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT,
    "capacity" INTEGER NOT NULL,
    "positionX" INTEGER,
    "positionY" INTEGER,
    "status" "RestaurantTableStatus" NOT NULL DEFAULT 'AVAILABLE',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RestaurantTable_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DiningArea_tenantId_idx" ON "DiningArea"("tenantId");

-- CreateIndex
CREATE INDEX "DiningArea_branchId_idx" ON "DiningArea"("branchId");

-- CreateIndex
CREATE UNIQUE INDEX "DiningArea_branchId_name_key" ON "DiningArea"("branchId", "name");

-- CreateIndex
CREATE INDEX "RestaurantTable_tenantId_idx" ON "RestaurantTable"("tenantId");

-- CreateIndex
CREATE INDEX "RestaurantTable_branchId_idx" ON "RestaurantTable"("branchId");

-- CreateIndex
CREATE INDEX "RestaurantTable_areaId_idx" ON "RestaurantTable"("areaId");

-- CreateIndex
CREATE INDEX "RestaurantTable_status_idx" ON "RestaurantTable"("status");

-- CreateIndex
CREATE UNIQUE INDEX "RestaurantTable_areaId_code_key" ON "RestaurantTable"("areaId", "code");

-- AddForeignKey
ALTER TABLE "DiningArea" ADD CONSTRAINT "DiningArea_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiningArea" ADD CONSTRAINT "DiningArea_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RestaurantTable" ADD CONSTRAINT "RestaurantTable_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RestaurantTable" ADD CONSTRAINT "RestaurantTable_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RestaurantTable" ADD CONSTRAINT "RestaurantTable_areaId_fkey" FOREIGN KEY ("areaId") REFERENCES "DiningArea"("id") ON DELETE CASCADE ON UPDATE CASCADE;

