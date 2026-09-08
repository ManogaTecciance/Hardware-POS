-- D90 — opening hours the owner sets, per weekday and per date.
--
-- Additive only: two new tables, no existing column touched. A deploy that
-- runs this without the new UI behaves exactly as it did before, because an
-- unconfigured branch resolves to the same 08:00-23:00 the calendar drew.
--
-- Times are minutes since LOCAL midnight. `closesAt` may exceed 1440 for a
-- kitchen that shuts in the small hours (01:00 = 1500).

-- CreateTable
CREATE TABLE "BranchOpeningHours" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "dayOfWeek" INTEGER NOT NULL,
    "isClosed" BOOLEAN NOT NULL DEFAULT false,
    "opensAt" INTEGER NOT NULL DEFAULT 480,
    "closesAt" INTEGER NOT NULL DEFAULT 1380,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BranchOpeningHours_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BranchOpeningHoursOverride" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "isClosed" BOOLEAN NOT NULL DEFAULT false,
    "opensAt" INTEGER NOT NULL DEFAULT 480,
    "closesAt" INTEGER NOT NULL DEFAULT 1380,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BranchOpeningHoursOverride_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BranchOpeningHours_tenantId_idx" ON "BranchOpeningHours"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "BranchOpeningHours_branchId_dayOfWeek_key" ON "BranchOpeningHours"("branchId", "dayOfWeek");

-- CreateIndex
CREATE INDEX "BranchOpeningHoursOverride_tenantId_idx" ON "BranchOpeningHoursOverride"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "BranchOpeningHoursOverride_branchId_date_key" ON "BranchOpeningHoursOverride"("branchId", "date");

-- AddForeignKey
ALTER TABLE "BranchOpeningHours" ADD CONSTRAINT "BranchOpeningHours_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BranchOpeningHours" ADD CONSTRAINT "BranchOpeningHours_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BranchOpeningHoursOverride" ADD CONSTRAINT "BranchOpeningHoursOverride_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BranchOpeningHoursOverride" ADD CONSTRAINT "BranchOpeningHoursOverride_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
