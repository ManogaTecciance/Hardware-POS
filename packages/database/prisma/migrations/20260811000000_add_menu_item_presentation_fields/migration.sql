-- Restaurant Menu Wizard — additive presentation fields on MenuItem and a
-- role marker on ModifierGroup. Backs the Add Menu Item wizard's Step 1
-- (image / item type / dietary tags / prep minutes) and the wizard's ability
-- to tell a Size variation group apart from a plain Extras group.
--
-- Fully additive per D15/D30. Nothing dropped, no column altered on legacy
-- data. Every new column is nullable or defaulted so pre-migration rows
-- stay valid:
--   • prepMinutes  — NULL for legacy items (no estimate)
--   • itemType     — NULL for legacy items (Menu filter treats as unset)
--   • dietaryTags  — empty array for legacy items
--   • imageUrl     — NULL for legacy items (menu card renders a placeholder)
--   • ModifierGroup.role — NULL for legacy groups (wizard treats as generic
--     modifier group, never as a size variation)
--
-- No data backfill required — every new column has a safe default read.

-- ── enum ─────────────────────────────────────────────────────────────────

CREATE TYPE "MenuItemType" AS ENUM ('FOOD', 'BEVERAGE', 'DESSERT');

-- ── MenuItem presentation columns ────────────────────────────────────────

ALTER TABLE "MenuItem"
  ADD COLUMN "prepMinutes" INTEGER,
  ADD COLUMN "itemType"    "MenuItemType",
  ADD COLUMN "dietaryTags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "imageUrl"    TEXT;

-- ── ModifierGroup role marker ────────────────────────────────────────────

ALTER TABLE "ModifierGroup"
  ADD COLUMN "role" TEXT;
