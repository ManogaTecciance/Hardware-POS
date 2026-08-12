-- Restaurant Product wizard + Promotions (D45). Additive per D15.
--
-- Merges Restaurant Menu Item authority into the Product wizard for
-- Restaurant tenants:
--   • Restaurant-specific columns land on Product (`prepMinutes`,
--     `dietaryTags`, `foodType`) — nullable / defaulted so Retail rows
--     (Tile Shop, Hardware) stay valid without a backfill.
--   • Product ↔ ModifierGroup and Product ↔ KitchenStation become
--     peer junctions alongside the existing MenuItem junctions. The
--     MenuItem junctions stay live for read-only historical MenuItems
--     during transition (Product Owner picked "Read-only deprecate").
--   • A new Promotion domain (Bundle / BOGO / % / fixed discount) lives
--     alongside the existing operator-applied `Discount` model without
--     touching it. `Discount` remains authoritative for retail line/
--     order discounts; `Promotion` covers scheduled auto-apply rules
--     evaluated server-side.
--
-- Nothing existing is altered. `MenuItem` and every menu junction stay
-- untouched — historical orders/KOTs/bills continue to reference them.

-- ─────────────────────────────────────────────────────────────
-- Enums
-- ─────────────────────────────────────────────────────────────

CREATE TYPE "PromotionType" AS ENUM (
    'BUNDLE_FIXED_PRICE',
    'BUY_X_GET_Y',
    'PERCENTAGE_DISCOUNT',
    'FIXED_AMOUNT_DISCOUNT'
);

CREATE TYPE "PromotionItemRole" AS ENUM ('BUY', 'GET', 'BUNDLE');

-- ─────────────────────────────────────────────────────────────
-- Product additive columns
-- ─────────────────────────────────────────────────────────────
--
-- `foodType` reuses the `MenuItemType` enum introduced by D41 — the
-- semantic vocabulary (FOOD / BEVERAGE / DESSERT) is identical, so
-- introducing a parallel `ProductFoodType` enum would create a
-- pointless second authority.
--
-- `dietaryTags` mirrors the `MenuItem.dietaryTags` shape verbatim
-- (TEXT[] with an empty-array default) so the migration path to a
-- Restaurant Product carries the same set of tags without translation.

ALTER TABLE "Product"
    ADD COLUMN "prepMinutes" INTEGER,
    ADD COLUMN "dietaryTags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    ADD COLUMN "foodType"    "MenuItemType";

-- ─────────────────────────────────────────────────────────────
-- ProductVariant additive column
-- ─────────────────────────────────────────────────────────────
--
-- One variant per product may be marked `isDefault=true` — the POS
-- quick-add path picks this one when the operator taps the product
-- card without opening the variant picker.
--
-- Uniqueness of "one default per product" is enforced by a partial
-- unique index (Prisma cannot declare it) so we can add it here.

ALTER TABLE "ProductVariant"
    ADD COLUMN "isDefault" BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX "ProductVariant_productId_default_key"
    ON "ProductVariant"("productId")
    WHERE "isDefault" = true;

-- ─────────────────────────────────────────────────────────────
-- ProductModifierGroup — junction (Product ↔ ModifierGroup)
-- ─────────────────────────────────────────────────────────────

CREATE TABLE "ProductModifierGroup" (
    "id"              TEXT NOT NULL,
    "productId"       TEXT NOT NULL,
    "modifierGroupId" TEXT NOT NULL,
    "position"        INTEGER NOT NULL DEFAULT 0,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductModifierGroup_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProductModifierGroup_productId_modifierGroupId_key"
    ON "ProductModifierGroup"("productId", "modifierGroupId");
CREATE INDEX "ProductModifierGroup_modifierGroupId_idx"
    ON "ProductModifierGroup"("modifierGroupId");

ALTER TABLE "ProductModifierGroup"
    ADD CONSTRAINT "ProductModifierGroup_productId_fkey"
    FOREIGN KEY ("productId") REFERENCES "Product"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProductModifierGroup"
    ADD CONSTRAINT "ProductModifierGroup_modifierGroupId_fkey"
    FOREIGN KEY ("modifierGroupId") REFERENCES "ModifierGroup"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────
-- ProductStationLink — junction (Product ↔ KitchenStation)
-- ─────────────────────────────────────────────────────────────
--
-- Mirrors `MenuItemStationLink`. A single product may route to
-- several stations (a burger with a milkshake side). KOT generation
-- widens to read from EITHER junction depending on whether the round
-- item was sourced from a MenuItem or a Product.

CREATE TABLE "ProductStationLink" (
    "id"        TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "stationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductStationLink_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProductStationLink_productId_stationId_key"
    ON "ProductStationLink"("productId", "stationId");
CREATE INDEX "ProductStationLink_stationId_idx"
    ON "ProductStationLink"("stationId");

ALTER TABLE "ProductStationLink"
    ADD CONSTRAINT "ProductStationLink_productId_fkey"
    FOREIGN KEY ("productId") REFERENCES "Product"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProductStationLink"
    ADD CONSTRAINT "ProductStationLink_stationId_fkey"
    FOREIGN KEY ("stationId") REFERENCES "KitchenStation"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────
-- Promotion — scheduled auto-apply rules
-- ─────────────────────────────────────────────────────────────
--
-- Distinct from `Discount` (retail operator-applied at sale time).
-- Server-side evaluation freezes the discount into the sale snapshot
-- at order-close time. This D45 slice ships models + admin CRUD +
-- POS badge; sale-close integration is a follow-up.
--
-- Schedule columns are ALL nullable — a promotion with `startsOn` +
-- `endsOn` both NULL is always-eligible-by-date. A promotion with
-- `daysOfWeek` empty is eligible every day. A promotion with
-- `startTime`/`endTime` NULL runs the whole day. This is more useful
-- than the alternative (a NOT NULL "always" sentinel) because it
-- surfaces schedule intent in the row directly.

CREATE TABLE "Promotion" (
    "id"              TEXT NOT NULL,
    "tenantId"        TEXT NOT NULL,
    "name"            TEXT NOT NULL,
    "description"     TEXT,
    "type"            "PromotionType" NOT NULL,
    -- BUNDLE_FIXED_PRICE — the collapsed price for the bundle.
    "fixedPrice"      DECIMAL(12,2),
    -- PERCENTAGE_DISCOUNT / BUY_X_GET_Y — 0-100. 100 = free reward.
    "percentageOff"   DECIMAL(5,2),
    -- FIXED_AMOUNT_DISCOUNT — money off.
    "amountOff"       DECIMAL(12,2),
    -- BUY_X_GET_Y — how many of the BUY item must be in the cart.
    "buyQuantity"     INTEGER,
    -- BUY_X_GET_Y — how many rewards are awarded per trigger.
    "getQuantity"     INTEGER,
    -- Schedule.
    "startsOn"        TIMESTAMP(3),
    "endsOn"          TIMESTAMP(3),
    -- Enum-string array (Postgres treats enum[] identically for our
    -- use). Kept as TEXT[] here so a new day-of-week does not become
    -- a schema migration.
    "daysOfWeek"      TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    -- HH:MM local tenant time; both NULL = whole day.
    "startTime"       TEXT,
    "endTime"         TEXT,
    -- Empty = all branches, else specific branchIds.
    "branchScope"     TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    -- Empty = all channels, else RestaurantOrderChannel names
    -- (DINE_IN / TAKEAWAY / ONLINE).
    "channelScope"    TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    -- Default (per brief): promotions do not stack unless explicitly
    -- allowed.
    "stackable"       BOOLEAN NOT NULL DEFAULT false,
    "isActive"        BOOLEAN NOT NULL DEFAULT true,

    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Promotion_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Promotion_tenantId_idx" ON "Promotion"("tenantId");
CREATE INDEX "Promotion_tenantId_isActive_idx" ON "Promotion"("tenantId", "isActive");
CREATE INDEX "Promotion_startsOn_endsOn_idx" ON "Promotion"("startsOn", "endsOn");
CREATE UNIQUE INDEX "Promotion_tenantId_name_key" ON "Promotion"("tenantId", "name");

ALTER TABLE "Promotion"
    ADD CONSTRAINT "Promotion_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────
-- PromotionItem — junction (Promotion ↔ Product with role)
-- ─────────────────────────────────────────────────────────────

CREATE TABLE "PromotionItem" (
    "id"          TEXT NOT NULL,
    "promotionId" TEXT NOT NULL,
    "productId"   TEXT NOT NULL,
    "role"        "PromotionItemRole" NOT NULL,
    "quantity"    INTEGER NOT NULL DEFAULT 1,

    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PromotionItem_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PromotionItem_promotionId_productId_role_key"
    ON "PromotionItem"("promotionId", "productId", "role");
CREATE INDEX "PromotionItem_productId_idx"
    ON "PromotionItem"("productId");
CREATE INDEX "PromotionItem_promotionId_idx"
    ON "PromotionItem"("promotionId");

ALTER TABLE "PromotionItem"
    ADD CONSTRAINT "PromotionItem_promotionId_fkey"
    FOREIGN KEY ("promotionId") REFERENCES "Promotion"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PromotionItem"
    ADD CONSTRAINT "PromotionItem_productId_fkey"
    FOREIGN KEY ("productId") REFERENCES "Product"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
