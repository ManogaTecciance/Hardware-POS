-- D102 (4.1) — promotion allocation: the columns, shipped inert.
--
-- Phase 4 builds the discount engine. The Promotion models, the four types and
-- the schedule already exist; nothing turns a promotion into money, which is
-- audit item A4 — a customer sees a "Buy 2 Get 1" badge and pays full price.
--
-- ── Nothing reads these columns yet ───────────────────────────────────────────
--
-- Same pattern as D101 (3.8): the columns and their defaults ship first, and the
-- applier that writes them lands in 4.2. Restaurant, hardware and retail behave
-- identically after this migration.
--
-- ── Why one migration ─────────────────────────────────────────────────────────
--
-- Four ADD COLUMNs, no new type, no enum value, no backfill. D99a's
-- two-migration rule is scoped to `ALTER TYPE … ADD VALUE` and does not apply.
--
-- PostgreSQL 11+ adds a defaulted column without rewriting the table, so this is
-- fast regardless of how many sale lines a tenant has.

-- ── 1. SaleItem.promotionDiscountAmount ───────────────────────────────────────
--
-- The promotion's reduction of THIS line. Per line, not order-level, and that is
-- the whole decision D102 records:
--
--   Two shirts at 1,000 and a tie at 500, tie free under buy-two-get-one. The
--   customer pays 2,000 and returns the tie. Allocating the 500 saving ORDER-WIDE
--   by line value gives the tie a weight of 500 against the shirts' 2,000, so it
--   absorbs 100 and refunds 500 - 100 = 400 — Rs 400 back on an item the customer
--   paid nothing for. Per line, the tie carries 500 here and `lineTotal` 0, so it
--   refunds 0 with no special case.
--
-- DEFAULT 0, not nullable, because "no promotion" and "a promotion worth nothing"
-- are the same fact for this column — unlike `taxRatePercent`, where NULL and
-- 0.00 are different facts (D101, and the trap 3.16 documented).
--
-- A MIRROR, not the authority. `lineTotal` is already net of this and is what
-- `taxableBase` and `returns.calc` read. The column exists so Phase 8 can report
-- promotional savings without a second source of truth — the relationship D100
-- records between `Product.quantityOnHand` and the per-variant rows.
--
-- INVARIANT: at most one of `discountAmount` and `promotionDiscountAmount` is
-- non-zero on a line. A manual discount overrides any promotion on that line, so
-- they are mutually exclusive by construction. Enforced in the applier and pinned
-- by test, not here — this schema uses neither CHECK constraints nor triggers.
ALTER TABLE "SaleItem" ADD COLUMN "promotionDiscountAmount" DECIMAL(12,2) NOT NULL DEFAULT 0;

-- ── 2 & 3. Which promotion, and what it was called ────────────────────────────
--
-- No FOREIGN KEY, deliberately. A constraint would restrict deleting a promotion
-- that has ever been sold, and a shop that ran a Christmas offer should be able
-- to remove it without the sale history refusing.
--
-- The name is SNAPSHOT for the same reason `variantNameSnapshot` is (D44): a
-- promotion can be renamed or deleted after the sale, and a reprinted receipt
-- must still name what the customer was actually given.
ALTER TABLE "SaleItem" ADD COLUMN "promotionId" TEXT;
ALTER TABLE "SaleItem" ADD COLUMN "promotionNameSnapshot" TEXT;

-- ── 4. ReturnItem.promotionDiscountAdjustment ─────────────────────────────────
--
-- The promotion REVERSED on a return line, beside the two adjustments already
-- there. Deliberately of the LINE-level shape — `promotionDiscountAmount × frac`,
-- like `productDiscountAdjustment` and unlike `orderDiscountAdjustment`, which
-- carries a basket-weighted share.
--
-- That difference is the point: a BOGO saving belongs to the free ITEM, not to
-- the basket by value. Reversing it order-wide is the same failure `3.11` removed
-- for tax, where proration refunded tax on a zero-rated line.
ALTER TABLE "ReturnItem" ADD COLUMN "promotionDiscountAdjustment" DECIMAL(12,2) NOT NULL DEFAULT 0;
