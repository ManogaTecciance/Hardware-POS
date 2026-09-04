-- D105 — cart-level FIXED_AMOUNT_DISCOUNT promotions.
--
-- Five additive, nullable-or-defaulted columns. Nothing is backfilled and
-- nothing is rewritten: every existing promotion has no threshold (NULL) and
-- every existing sale and return carries 0.00, which is exactly what they mean
-- today. The migration is inert until a cart-level promotion is configured.
--
-- Why the order level and not SaleItem: a SaleItem holds ONE promotionId, and a
-- cart-level promotion must coexist with the line-level promotions that already
-- claimed those lines. The manual order discount beside it already solves the
-- same problem, return allocation included, so this mirrors that shape.

ALTER TABLE "Promotion"
  ADD COLUMN IF NOT EXISTS "minimumSpend" DECIMAL(12,2);

ALTER TABLE "Sale"
  ADD COLUMN IF NOT EXISTS "promotionOrderDiscountAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "promotionOrderId" TEXT,
  ADD COLUMN IF NOT EXISTS "promotionOrderNameSnapshot" TEXT;

ALTER TABLE "Return"
  ADD COLUMN IF NOT EXISTS "promotionOrderDiscountAdjustment" DECIMAL(12,2) NOT NULL DEFAULT 0;

ALTER TABLE "ReturnItem"
  ADD COLUMN IF NOT EXISTS "promotionOrderDiscountAdjustment" DECIMAL(12,2) NOT NULL DEFAULT 0;
