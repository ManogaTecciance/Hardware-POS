-- D101 (3.8) — per-line tax: the columns, shipped inert.
--
-- Phase 3 narrowed to Option B (Tech Lead, 2026-09-02). The flat-rate engine
-- already works for retail — 18% on a clothing workspace produces
-- 1,850 -> 333 -> 2,183 with no code. Per-category rates are a GROCERY
-- requirement and are parked in Phase 6, so no `TaxRate` or `TaxRule` tables.
--
-- ── Nothing reads these columns yet ───────────────────────────────────────────
--
-- Deliberate, and the pattern `RestaurantBranchConfig.taxRatePercent` used:
-- "No UI yet, deliberately; the column and fallback ship first." Restaurant,
-- hardware and retail behave identically after this migration.
--
-- ── Why one migration ─────────────────────────────────────────────────────────
--
-- D99a's two-migration rule is scoped to `ALTER TYPE … ADD VALUE`: PostgreSQL
-- refuses to USE a new enum label in the transaction that adds it. Nothing here
-- adds an enum value — three columns, no new type — so splitting would be
-- following a rule past its reason.
--
-- No backfill either. That is what the nullable rate columns buy.

-- ── 1. Product.taxable ────────────────────────────────────────────────────────
--
-- TRUE because that is already true of every product. There is no per-product
-- exemption anywhere today; tax is one rate on the whole bill, so every product
-- is taxed. This records the existing fact rather than changing it.
--
-- A default of FALSE would assert that every product in every tenant is exempt.
-- The moment anything read it, a restaurant selling a Rs 2,000 meal would charge
-- Rs 0 tax instead of Rs 360 — silently, across every tenant.
--
-- PostgreSQL 11+ adds a defaulted column without rewriting the table, so this is
-- fast regardless of how many products a tenant has.
ALTER TABLE "Product" ADD COLUMN "taxable" BOOLEAN NOT NULL DEFAULT true;

-- ── 2 & 3. The rate snapshots ─────────────────────────────────────────────────
--
-- NULLABLE, not DEFAULT 0. `0.00` means ZERO-RATED; NULL means no rate was
-- recorded. They are different facts and the distinction is load-bearing:
-- defaulting to 0 would claim every historical sale was zero-rated, and a return
-- against one would refund no tax at all.
--
-- With NULL, `returns.calc` recognises "this line predates the snapshot" and
-- falls back to today's proportional method — so every existing sale keeps
-- refunding exactly as it does now. That fallback is what makes this migration
-- safe on live data.
--
-- Follows `RestaurantBranchConfig.taxRatePercent`, nullable for the same stated
-- reason: "0 is a meaningful rate and must be distinguishable from unset".
--
-- DECIMAL(5,2) matches every other rate column in the schema.
ALTER TABLE "SaleItem" ADD COLUMN "taxRatePercent" DECIMAL(5,2);

-- The rate REVERSED, copied from the original SaleItem rather than re-resolved
-- (1a.20's rule), so a rate change between purchase and return cannot alter the
-- refund, and a credit note can show the breakdown.
ALTER TABLE "ReturnItem" ADD COLUMN "taxRatePercent" DECIMAL(5,2);
