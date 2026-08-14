-- D59 (plan Q5) — per-branch tax rate override. Purely additive: one nullable
-- column; NULL inherits the tenant-wide TenantSettings.taxRatePercent, so no
-- existing branch changes behaviour.

-- AlterTable
ALTER TABLE "RestaurantBranchConfig" ADD COLUMN "taxRatePercent" DECIMAL(5,2);
