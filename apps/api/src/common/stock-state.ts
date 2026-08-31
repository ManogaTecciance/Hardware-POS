import { Prisma } from '@hardware-pos/database';

/**
 * How a quantity is described to the till.
 *
 * `UNTRACKED` is a real, distinct state rather than a null — a SERVICE sells with
 * no stock claim at all and must not read as `OUT`, which would grey it out.
 */
export type StockState = 'IN_STOCK' | 'LOW' | 'OUT' | 'UNTRACKED';

/**
 * Classify an on-hand quantity against an optional reorder level.
 *
 * Extracted so the item level and the variant level cannot disagree about what
 * "low" means. `sellable.service` computed this inline for products; D99 added the
 * same question per variant, and two copies of a threshold rule is how a variant
 * ends up badged `IN_STOCK` on the same screen where its product reads `LOW`.
 *
 * `Prisma.Decimal` throughout (D59) — comparing a `toNumber()` against a Decimal
 * reorder level is the float boundary this codebase keeps out of money and
 * quantities alike.
 */
export function stockStateFor(
  quantityOnHand: Prisma.Decimal,
  reorderLevel: Prisma.Decimal | null,
): StockState {
  if (quantityOnHand.lessThanOrEqualTo(0)) return 'OUT';
  if (reorderLevel && quantityOnHand.lessThanOrEqualTo(reorderLevel)) return 'LOW';
  return 'IN_STOCK';
}
