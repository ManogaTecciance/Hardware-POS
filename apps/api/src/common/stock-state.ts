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

/**
 * One variant's contribution to its product's stock figure.
 *
 * `reorderLevel` is per variant, so "low" is asked of each size against its own
 * threshold rather than of the total against a product-level one.
 */
export interface VariantStockCell {
  qty: Prisma.Decimal;
  reorderLevel: Prisma.Decimal | null;
}

/**
 * Roll a product's variant stock up into the single figure its card shows.
 *
 * ## Why this exists (D99, 1c.6)
 *
 * Stock is tracked by **variant**, not by product. `Product.quantityOnHand` is a
 * legacy rollup *mirror* (D10) — maintained on sale and receipt, but a mirror, and
 * a mirror can drift. One out-of-band write is enough: a product read 350 while its
 * four sizes held 22 between them, and the till advertised the 350.
 *
 * So a product with variants derives its figure from the rows that are actually
 * authoritative, and the mirror is not consulted.
 *
 * Deriving here rather than in the till is deliberate. D31 makes the server the
 * authority; the alternative was the same aggregation in `pos-retail-checkout` and
 * again in `quotation-builder`, which is two copies of one rule and therefore an
 * eventual disagreement between two screens.
 *
 * ## The rules
 *
 * - **Quantity** is the sum across sizes. Unlike price, a total is informative
 *   rather than misleading: nothing caps a sale by it (the till caps per variant),
 *   and "22 brushes across 4 sizes" is a true and useful thing for a cashier.
 * - **`OUT` only when every size is out.** A shirt with no Mediums is still a
 *   sellable shirt, and greying the card would hide the Larges.
 * - **`LOW` when no size is `IN_STOCK`** but something remains — every size is at
 *   or below its own reorder point.
 *
 * There is deliberately no `UNTRACKED` case. `stockStateFor` cannot return it, and
 * the caller only reaches this helper inside its `tracksStock` branch — a tenant
 * that tracks no stock is answered before any variant is consulted. An
 * `every(s === 'UNTRACKED')` guard here was unreachable, and the test written for
 * it asserted `OUT` while claiming to cover `UNTRACKED`: a vacuous test of the
 * exact kind D30 exists to prevent. Both are gone.
 */
export function aggregateVariantStock(
  cells: readonly VariantStockCell[],
): { quantity: Prisma.Decimal; state: StockState } {
  if (cells.length === 0) {
    return { quantity: new Prisma.Decimal(0), state: 'OUT' };
  }

  let quantity = new Prisma.Decimal(0);
  for (const cell of cells) quantity = quantity.plus(cell.qty);

  const states = cells.map((c) => stockStateFor(c.qty, c.reorderLevel));

  // Ordered strongest claim first: "no size has any" must be settled before
  // "some size is comfortable", or a single healthy size would mask nothing —
  // but "every size is out" would never be reachable if IN_STOCK were asked first.
  if (states.every((s) => s === 'OUT')) return { quantity, state: 'OUT' };
  if (states.some((s) => s === 'IN_STOCK')) return { quantity, state: 'IN_STOCK' };
  return { quantity, state: 'LOW' };
}
