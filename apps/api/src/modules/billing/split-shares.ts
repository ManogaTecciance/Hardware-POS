import { Prisma } from '@hardware-pos/database';

/**
 * D51 — turning item assignments into money.
 *
 * Pure and dependency-free so the one rule that must never drift — every
 * split's share summing to exactly the bill total — is provable without a
 * database. The service does the I/O; this does the arithmetic.
 */

export interface SplitAllocationInput {
  /** Each split's own item subtotal: Σ (unitPrice + modifierTotal) × assigned qty. */
  itemSubtotals: Prisma.Decimal[];
  /** The sale's item subtotal — the weight base. */
  subtotal: Prisma.Decimal;
  /** The sale's grand total. The difference from `subtotal` is what gets spread. */
  total: Prisma.Decimal;
}

const ZERO = new Prisma.Decimal(0);
const CENT = new Prisma.Decimal('0.01');

/**
 * Split shares that sum to `total` exactly.
 *
 * Each split gets its own items plus a pro-rata slice of everything else on
 * the bill (service charge, tax, packaging, discounts — whatever accounts for
 * the gap between subtotal and total), weighted by its item subtotal.
 *
 * Rounding is **largest remainder**: shares are truncated to 2dp and the
 * leftover cents are handed out one at a time, biggest fractional part first.
 * Naive per-split rounding would drift by a cent or two on a long bill and
 * leave the sale unpayable — the payment path refuses a tender that exceeds
 * the balance, so a one-cent surplus is a stuck bill, not a cosmetic bug.
 *
 * Ties break toward the earlier split: deterministic, so the same assignment
 * always produces the same bills.
 */
export function allocateSplitShares(input: SplitAllocationInput): Prisma.Decimal[] {
  const { itemSubtotals, subtotal, total } = input;
  const count = itemSubtotals.length;
  if (count === 0) return [];

  const weightBase = subtotal;
  // A comped tab (everything zero-priced) has no weights to divide by. Spread
  // whatever remains — a flat service charge, say — evenly instead of failing.
  const useEvenWeights = weightBase.lessThanOrEqualTo(ZERO);

  const exact = itemSubtotals.map((itemSubtotal, i) => {
    if (useEvenWeights) {
      return total.div(count);
    }
    const weight = itemSubtotal.div(weightBase);
    const extras = total.minus(subtotal);
    return itemSubtotal.plus(extras.mul(weight));
  });

  // Floor to the cent, then distribute the remainder by largest fractional part.
  const floored = exact.map((v) => v.toDecimalPlaces(2, Prisma.Decimal.ROUND_DOWN));
  const distributed = floored.reduce((acc, v) => acc.plus(v), ZERO);
  let remainingCents = total.minus(distributed).div(CENT).toDecimalPlaces(0).toNumber();

  const order = exact
    .map((v, i) => ({ i, frac: v.minus(floored[i]!) }))
    .sort((a, b) => {
      const cmp = b.frac.comparedTo(a.frac);
      return cmp !== 0 ? cmp : a.i - b.i;
    });

  const shares = [...floored];
  let cursor = 0;
  while (remainingCents > 0 && order.length > 0) {
    const target = order[cursor % order.length]!.i;
    shares[target] = shares[target]!.plus(CENT);
    remainingCents -= 1;
    cursor += 1;
  }
  // A negative remainder means flooring overshot — only reachable if `total`
  // is below the summed floors (a discount-heavy bill). Claw back the same way.
  while (remainingCents < 0 && order.length > 0) {
    const target = order[order.length - 1 - (cursor % order.length)]!.i;
    shares[target] = shares[target]!.minus(CENT);
    remainingCents += 1;
    cursor += 1;
  }
  return shares;
}

/** Line total for an assigned portion: (unitPrice + modifierTotal) × quantity. */
export function lineTotal(
  unitPrice: Prisma.Decimal,
  modifierTotal: Prisma.Decimal,
  quantity: Prisma.Decimal,
): Prisma.Decimal {
  return unitPrice.plus(modifierTotal).mul(quantity);
}
