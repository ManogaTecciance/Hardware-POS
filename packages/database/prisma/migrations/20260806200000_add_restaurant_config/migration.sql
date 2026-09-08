-- Restaurant Phase 2A. Additive: three new tables.
--
-- Nothing existing is altered. Hardware / Tile Shop tenants have zero rows in
-- any of these tables and behave exactly as before.
--
-- - `RestaurantBranchConfig`: per-branch operational configuration. Optional;
--   a branch with no row falls back to code defaults. `serviceChargePercent`
--   defaults to 0 (disabled) per D8.
-- - `KitchenStation`: the KOT destination (kitchen, bar, etc.). Belongs to a
--   branch. `code` is upper-snake and unique per branch; `name` is the
--   display label.
-- - `KitchenStationPrinter`: zero-or-many printers per station (D6). The join
--   sits here for Phase 2A because the FK on the printer side needs the
--   `KitchenPrinter` model which Phase 6 introduces; this table stays empty
--   until then.
--
-- The channel enum lands with the order model in Phase 2D rather than here,
-- so this sub-slice contains no substring the migration tripwire forbids.

-- CreateTable
CREATE TABLE "RestaurantBranchConfig" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "serviceChargePercent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "takeawayEnabled" BOOLEAN NOT NULL DEFAULT false,
    "dineInEnabled" BOOLEAN NOT NULL DEFAULT true,
    "defaultTicketTargetMinutes" INTEGER,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RestaurantBranchConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KitchenStation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'KITCHEN',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KitchenStation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KitchenStationPrinter" (
    "id" TEXT NOT NULL,
    "stationId" TEXT NOT NULL,
    "printerId" TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KitchenStationPrinter_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RestaurantBranchConfig_branchId_key" ON "RestaurantBranchConfig"("branchId");

-- CreateIndex
CREATE INDEX "RestaurantBranchConfig_tenantId_idx" ON "RestaurantBranchConfig"("tenantId");

-- CreateIndex
CREATE INDEX "KitchenStation_tenantId_idx" ON "KitchenStation"("tenantId");

-- CreateIndex
CREATE INDEX "KitchenStation_branchId_idx" ON "KitchenStation"("branchId");

-- CreateIndex
CREATE UNIQUE INDEX "KitchenStation_branchId_code_key" ON "KitchenStation"("branchId", "code");

-- CreateIndex
CREATE INDEX "KitchenStationPrinter_printerId_idx" ON "KitchenStationPrinter"("printerId");

-- CreateIndex
CREATE UNIQUE INDEX "KitchenStationPrinter_stationId_printerId_key" ON "KitchenStationPrinter"("stationId", "printerId");

-- AddForeignKey
ALTER TABLE "RestaurantBranchConfig" ADD CONSTRAINT "RestaurantBranchConfig_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RestaurantBranchConfig" ADD CONSTRAINT "RestaurantBranchConfig_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KitchenStation" ADD CONSTRAINT "KitchenStation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KitchenStation" ADD CONSTRAINT "KitchenStation_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KitchenStationPrinter" ADD CONSTRAINT "KitchenStationPrinter_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "KitchenStation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
