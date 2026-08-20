-- D67 — the workspace-wide default kitchen printer (PO clarification,
-- 2026-08-18): the owner adds printers once, each user picks their own
-- defaults from that list, and this column is what a user who has picked
-- nothing falls back to. Additive and nullable — a branch that has not set
-- one behaves exactly as before.

-- AlterTable
ALTER TABLE "RestaurantBranchConfig" ADD COLUMN     "defaultKitchenPrinterId" TEXT;
