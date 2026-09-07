-- A FIXED line discount can now be an amount per unit rather than per line.
--
-- A new column rather than a new DiscountType member: the whole-cart order
-- discount shares DiscountType and has no units, so a FIXED_PER_UNIT member
-- there would validate and persist while meaning nothing.

-- CreateEnum
CREATE TYPE "DiscountBasis" AS ENUM ('LINE', 'UNIT');

-- AlterTable
-- NOT NULL with a non-volatile default: instant on PG 11+, no table rewrite,
-- and every existing FIXED line keeps the whole-line meaning it was rung up with.
ALTER TABLE "SaleItem" ADD COLUMN     "discountBasis" "DiscountBasis" NOT NULL DEFAULT 'LINE';
