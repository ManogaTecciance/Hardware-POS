-- D97 — takeaway is on unless somebody turns it off.
--
-- `TakeawayService.create` refuses only when a config row EXISTS and says
-- `takeawayEnabled = false`, so a branch with no row has always taken takeaway
-- orders. The column defaulted to false, which meant the mere act of CREATING
-- the row — which is what saving a service charge does (D84) — switched
-- takeaway off for a branch that had been working. Every order after that
-- failed with "Takeaway is disabled on this branch".
ALTER TABLE "RestaurantBranchConfig" ALTER COLUMN "takeawayEnabled" SET DEFAULT true;

-- Repair the rows the defect already produced.
--
-- Every `false` in this column was written by that create path: there is no UI
-- anywhere in the product that turns takeaway off, and the only writer that
-- ever sent the field explicitly is a test. So a blanket flip restores intent
-- rather than overriding anybody's choice. If a branch ever does want takeaway
-- off, the API takes `takeawayEnabled: false` and this migration has already
-- run.
UPDATE "RestaurantBranchConfig" SET "takeawayEnabled" = true WHERE "takeawayEnabled" = false;
