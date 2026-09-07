import { Prisma } from '@hardware-pos/database';

/**
 * `8.4` — split one sale's recorded tax across the rates its lines were charged
 * at, in `Prisma.Decimal`.
 *
 * ## Why this exists at all
 *
 * **`SaleItem.taxAmount` is always `0`.** `sales.service` writes it that way on
 * purpose — "splitting the order-level tax across lines is per-line COMPUTATION,
 * which is parked with grocery (D101)". Tax is computed once for the whole sale
 * and lives on `Sale.taxAmount`; the line carries only the RATE it was charged
 * at (`taxRatePercent`, frozen by D101).
 *
 * Verified on the pilot database rather than inferred from the comment: 43 sale
 * lines, none with a non-zero `taxAmount`, while 12 of 20 completed sales carry
 * tax. Any report that sums `SaleItem.taxAmount` therefore reads `0.00` for
 * every real sale — which is exactly what `8.3` shipped before this file
 * existed, and why the fix landed with it.
 *
 * ## Why not call `taxBreakdownForDocument`
 *
 * That helper implements this same weighting for a printed document, and the
 * arithmetic below is deliberately its twin — a parity test in
 * `report-tax-allocation.spec.ts` runs both over the same inputs and fails if
 * they ever diverge. It is not called directly for two reasons:
 *
 *  1. It returns `[]` when every line shares one rate, so a document does not
 *     print a breakdown that merely repeats the total it already printed. A
 *     PERIOD report is the opposite case: a single-rate shop reconciling its
 *     tax return needs that one row more than anyone.
 *  2. It works in `number`. A document allocates one sale's tax and prints it;
 *     a report adds thousands of those together, which is where float error
 *     accumulates — the shape audit item A8 describes (D108, D59).
 *
 * ## The rule
 *
 *     taxable_i = lineTotal_i − (orderDiscount × lineTotal_i / discountedSubtotal)
 *     weight_i  = taxable_i × ratePercent_i
 *     tax_i     = recordedTax × weight_i / Σweight
 *
 * `taxable_i` is line net less its proportional share of the order discount —
 * the same quantity `computeReturnLine` derives, so a printed document, a later
 * refund and this report all divide the recorded tax identically.
 *
 * The cart-level promotion (`Sale.promotionOrderDiscountAmount`) is deliberately
 * NOT subtracted: D105 applies it after tax, so it never entered the taxable
 * base and must not be removed from it here either.
 */

const ZERO = new Prisma.Decimal(0);

const D = (v: Prisma.Decimal | number | string): Prisma.Decimal =>
  v instanceof Prisma.Decimal ? v : new Prisma.Decimal(v);

/** Two decimal places, HALF_UP — the same `dp2` the money engine rounds with. */
const dp2 = (v: Prisma.Decimal): Prisma.Decimal => v.toDecimalPlaces(2);

export interface AllocatableLine {
  /** Line net after its own discount and promotion, before the order discount. */
  lineTotal: Prisma.Decimal | number;
  /**
   * The rate frozen onto the line (D101). `null` means the line predates 3.8 —
   * its own state, never to be read as 0%.
   */
  taxRatePercent: Prisma.Decimal | number | null;
}

export interface AllocatableSale {
  /** Σ lineSubtotal, before any discount. */
  subtotal: Prisma.Decimal | number;
  /** Σ line discounts and line promotions (D102). */
  totalDiscount: Prisma.Decimal | number;
  /** The manual order-level discount. */
  orderDiscountAmount: Prisma.Decimal | number;
  /** What the sale actually charged. This is the figure being divided up. */
  taxAmount: Prisma.Decimal | number;
}

export interface AllocatedLine {
  /** `null` when the line predates 3.8 and no rate was recorded. */
  ratePercent: Prisma.Decimal | null;
  /** Line net less its share of the order discount. */
  taxable: Prisma.Decimal;
  /** This line's share of the sale's recorded tax. Exact; the rows sum to it. */
  tax: Prisma.Decimal;
}

/**
 * Divide `sale.taxAmount` across `lines`, in line order.
 *
 * The result is the same length as the input, so a caller can zip it back
 * against the rows it already has.
 *
 * **A sale with any un-rated line gets no allocation at all**: every line comes
 * back with `tax = 0` and `ratePercent = null`, and the caller is expected to
 * report the sale's tax as unattributed rather than guessing. One missing rate
 * makes the whole weight unusable — the same conclusion `totalTaxWeight` reaches
 * — and a pre-3.8 sale is wholly pre-3.8, never a mixture.
 */
export function allocateSaleTax(
  lines: readonly AllocatableLine[],
  sale: AllocatableSale,
): AllocatedLine[] {
  if (lines.length === 0) return [];

  const discountedSubtotal = D(sale.subtotal).minus(D(sale.totalDiscount));
  const orderDiscount = D(sale.orderDiscountAmount);
  const recordedTax = D(sale.taxAmount);

  const taxables = lines.map((l) => {
    const lineTotal = D(l.lineTotal);
    const share = discountedSubtotal.greaterThan(0)
      ? orderDiscount.mul(lineTotal).div(discountedSubtotal)
      : ZERO;
    return lineTotal.minus(share);
  });

  const unrated = lines.some((l) => l.taxRatePercent === null);
  if (unrated) {
    return lines.map((_, i) => ({ ratePercent: null, taxable: dp2(taxables[i]!), tax: ZERO }));
  }

  const rates = lines.map((l) => D(l.taxRatePercent!));
  const weights = taxables.map((t, i) => t.mul(rates[i]!));
  const weightTotal = weights.reduce((acc, w) => acc.plus(w), ZERO);

  // Nothing to divide: a 0% tenant, an all-exempt basket, or a sale that
  // recorded no tax. Every line gets zero, which is the true answer rather than
  // a division that would throw.
  if (weightTotal.lessThanOrEqualTo(0) || recordedTax.isZero()) {
    return lines.map((_, i) => ({
      ratePercent: rates[i]!,
      taxable: dp2(taxables[i]!),
      tax: ZERO,
    }));
  }

  const allocated = lines.map((_, i) => ({
    ratePercent: rates[i]!,
    taxable: dp2(taxables[i]!),
    tax: dp2(recordedTax.mul(weights[i]!).div(weightTotal)),
  }));

  /*
   * The parts must add up to the whole. Each share was rounded independently,
   * so their sum can miss the recorded tax by a cent; the largest share absorbs
   * the difference, where it distorts least — the same remainder rule
   * `taxBreakdownForDocument` applies, so a report row and the receipt it came
   * from cannot disagree by that cent.
   */
  const drift = recordedTax.minus(allocated.reduce((acc, a) => acc.plus(a.tax), ZERO));
  if (!drift.isZero()) {
    let largest = 0;
    for (let i = 1; i < allocated.length; i += 1) {
      if (allocated[i]!.tax.greaterThan(allocated[largest]!.tax)) largest = i;
    }
    allocated[largest]!.tax = allocated[largest]!.tax.plus(drift);
  }

  return allocated;
}
