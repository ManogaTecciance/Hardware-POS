/**
 * Return refund calculation — the exact reversal of the sale compute pipeline in
 * `sales.service.ts`. All money math is done in plain JS numbers rounded to cents
 * with `round2` / `sum2` (the same primitives the sale used), so there is no
 * floating-point drift beyond the sale's own per-line rounding.
 *
 * The original sale applied, in order:
 *   1. per-line product discount        → lineTotal = unitPrice*qty - discount
 *   2. an order-level discount on the sum of lineTotals (discountedSubtotal)
 *   3. tax on (discountedSubtotal - orderDiscount)
 *
 * A return reverses each of those *proportionally* to the quantity being
 * returned. The order discount and tax were never stored per line, so each line's
 * share is re-derived here from the sale-level snapshot. Pure functions only —
 * unit-tested in returns.calc.spec.ts.
 */
import { round2, sum2 } from '../../common/money';

/** Sale-level figures needed to allocate order discount and tax to a line. */
export interface OriginalSaleSnapshot {
  /** Σ (unitPrice × qty) across all sale lines, pre-discount. */
  subtotal: number;
  /** Σ per-line product discount. */
  totalDiscount: number;
  /** Order-level discount amount applied to the post-line-discount subtotal. */
  orderDiscountAmount: number;
  /** Document-level tax amount on the sale. */
  taxAmount: number;
  /**
   * D101 (3.11) — Σ over EVERY sale line of `lineTaxable × taxRatePercent`.
   *
   * The denominator that allocates the sale's recorded tax across its lines by
   * how much tax each one actually attracted. Null for a sale written before
   * 3.8, where no line carries a rate and the proportional fallback applies.
   */
  taxWeightTotal: number | null;
}

/** The original sale line being (partially) returned. */
export interface OriginalLineSnapshot {
  unitPrice: number;
  purchasedQuantity: number;
  /** Product-level discount for the whole original line. */
  discountAmount: number;
  /** Net of the product discount: unitPrice*qty - discountAmount. */
  lineTotal: number;
  /**
   * D101 (3.11) — the rate this line was charged at, frozen at sale time.
   * Null for a line written before 3.8. `0` is a real rate (zero-rated or an
   * exempt product) and is not the same fact.
   */
  taxRatePercent: number | null;
}

export interface ComputedReturnLine {
  originalUnitPrice: number;
  returnQuantity: number;
  /** unitPrice × returnQuantity (pre-discount). */
  originalLineSubtotal: number;
  /** Proportional share of the line's product discount reversed. */
  productDiscountAdjustment: number;
  /** Proportional share of the sale's order discount reversed. */
  orderDiscountAdjustment: number;
  /** Proportional share of the sale's tax reversed. */
  taxAdjustment: number;
  /** The amount actually refundable for this returned quantity. */
  refundableAmount: number;
}

export interface ComputedReturnTotals {
  subtotal: number;
  productDiscountAdjustment: number;
  orderDiscountAdjustment: number;
  taxAdjustment: number;
  refundTotal: number;
}

/**
 * Compute the refundable breakdown for returning `returnQuantity` units of one
 * original sale line. `returnQuantity` must already be validated (> 0 and ≤ the
 * available return quantity) by the caller.
 */
export function computeReturnLine(
  sale: OriginalSaleSnapshot,
  line: OriginalLineSnapshot,
  returnQuantity: number,
): ComputedReturnLine {
  // Proportion of the line being returned, by quantity.
  const frac = line.purchasedQuantity > 0 ? returnQuantity / line.purchasedQuantity : 0;

  // 1. Original unit price × return quantity (pre-discount).
  const originalLineSubtotal = round2(line.unitPrice * returnQuantity);

  // 2. Proportional product (line-level) discount.
  const productDiscountAdjustment = round2(line.discountAmount * frac);

  // Net of the product discount for the returned portion.
  const lineNet = round2(originalLineSubtotal - productDiscountAdjustment);

  // 3. Proportional order-level discount. The sale spread its order discount
  //    across the sum of line nets (discountedSubtotal); this line's full share is
  //    orderDiscount × lineTotal / discountedSubtotal, then scaled by `frac`.
  const discountedSubtotal = round2(sale.subtotal - sale.totalDiscount);
  const orderDiscountShareFull =
    discountedSubtotal > 0 ? (sale.orderDiscountAmount * line.lineTotal) / discountedSubtotal : 0;
  const orderDiscountAdjustment =
    sale.orderDiscountAmount > 0 ? round2(orderDiscountShareFull * frac) : 0;

  /*
   * 4. Tax, allocated from the sale's RECORDED total rather than recomputed.
   *
   * D101 (3.11) weights each line by the tax it actually attracted:
   *
   *     taxAdjustment = saleTax × (lineTaxable × rate) / Σ(lineTaxable × rate)
   *
   * Four properties fall out of that shape rather than being engineered:
   *
   *   • UNIFORM RATES — `rate` cancels top and bottom, leaving exactly the
   *     formula this replaced. Every pre-existing assertion holds unchanged.
   *   • AN EXEMPT LINE contributes 0 to the numerator, so it refunds 0 — where
   *     the old denominator (`discountedSubtotal - orderDiscount`, which counts
   *     exempt lines) refunded tax that was never charged.
   *   • A TAXABLE LINE in a mixed basket gets the true base as its denominator,
   *     so it refunds everything it paid instead of a diluted share.
   *   • RECONCILIATION — the shares sum to 1 by construction, so Σ refunds
   *     equals the sale's tax exactly. That holds for a full return AND for any
   *     sequence of partial ones, which is why no line has to "absorb" a
   *     rounding remainder and why split returns need no bookkeeping.
   *
   * Allocation, not recomputation: a return can never refund a different amount
   * of tax than the sale charged.
   */
  const saleTaxable = round2(discountedSubtotal - sale.orderDiscountAmount);
  const lineTaxableFull = line.lineTotal - orderDiscountShareFull;
  const returnLineTaxable = lineTaxableFull * frac;

  // A sale is never mixed: 3.9 writes a rate on every line, so a sale is wholly
  // pre-3.8 or wholly post. Both halves are checked because either being absent
  // means the same thing — this sale predates the snapshot.
  const hasSnapshot = line.taxRatePercent !== null && sale.taxWeightTotal !== null;

  let taxAdjustment = 0;
  if (sale.taxAmount > 0) {
    if (hasSnapshot) {
      const weight = returnLineTaxable * line.taxRatePercent!;
      taxAdjustment =
        sale.taxWeightTotal! > 0 ? round2((sale.taxAmount * weight) / sale.taxWeightTotal!) : 0;
    } else if (saleTaxable > 0) {
      // Pre-3.8 sale: no rate was recorded, so the only available weight is the
      // taxable amount itself. This is the original expression, unchanged, and
      // it is what keeps historical refunds byte-identical.
      taxAdjustment = round2((sale.taxAmount * returnLineTaxable) / saleTaxable);
    }
  }

  // 5. Final refundable line amount.
  const refundableAmount = round2(lineNet - orderDiscountAdjustment + taxAdjustment);

  return {
    originalUnitPrice: line.unitPrice,
    returnQuantity,
    originalLineSubtotal,
    productDiscountAdjustment,
    orderDiscountAdjustment,
    taxAdjustment,
    refundableAmount,
  };
}

/** Roll up per-line figures into the Return-level totals (each summed to cents). */
export function sumReturnTotals(lines: ComputedReturnLine[]): ComputedReturnTotals {
  return {
    subtotal: sum2(lines.map((l) => l.originalLineSubtotal)),
    productDiscountAdjustment: sum2(lines.map((l) => l.productDiscountAdjustment)),
    orderDiscountAdjustment: sum2(lines.map((l) => l.orderDiscountAdjustment)),
    taxAdjustment: sum2(lines.map((l) => l.taxAdjustment)),
    refundTotal: sum2(lines.map((l) => l.refundableAmount)),
  };
}
