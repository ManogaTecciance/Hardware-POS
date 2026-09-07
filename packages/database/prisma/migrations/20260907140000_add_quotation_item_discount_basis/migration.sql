-- A quotation's FIXED line discount can now be an amount per unit, matching the
-- sale it converts into. Every revision owns its own items, so each keeps the
-- basis it was quoted at; existing rows default to LINE, the meaning they had.

-- AlterTable
ALTER TABLE "QuotationItem" ADD COLUMN     "discountBasis" "DiscountBasis" NOT NULL DEFAULT 'LINE';
