-- D52. Per-channel service charge, packaging charge and the taxable-base flag.
-- Purely additive: three defaulted columns, so every existing branch keeps its
-- current behaviour exactly (service charge on dine-in only, no packaging).

-- AlterTable
ALTER TABLE "RestaurantBranchConfig" ADD COLUMN     "packagingChargeAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "serviceChargeChannels" "RestaurantOrderChannel"[] DEFAULT ARRAY['DINE_IN']::"RestaurantOrderChannel"[],
ADD COLUMN     "serviceChargeTaxable" BOOLEAN NOT NULL DEFAULT true;

