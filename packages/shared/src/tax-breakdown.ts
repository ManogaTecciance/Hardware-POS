/**
 * Splitting a recorded tax total across the rates that produced it (D101, 3.12).
 *
 * ## Why this is allocation and not calculation
 *
 * `SaleItem.taxAmount` is always 0 — splitting the order-level tax across lines
 * is per-line COMPUTATION, parked with grocery. So a breakdown cannot be summed
 * from the lines; it has to divide the tax the sale actually recorded.
 *
 * That division is the same weighting `returns.calc` uses to allocate a refund:
 *
 *     share = recordedTax × Σ(taxable × rate for this rate) / Σ(taxable × rate)
 *
 * Both consume the primitives here rather than each expressing it, because two
 * ways to divide one total is two chances to disagree — the failure 2.12 found
 * across four document renderers, discovered on a customer-facing invoice.
 *
 * ## Why it lives in `shared`
 *
 * A sale line is rendered in four places, two per app. `saleLineLabel` is here
 * for the same reason, and `sale-line-renderers.spec` enumerates the four and
 * fails if one skips either function.
 */

/** One line's contribution: its taxable net and the rate frozen onto it. */
export interface TaxableLine {
  /**
   * The line's net AFTER its proportional share of the order discount — the
   * same quantity `computeReturnLine` derives, so numerator and denominator are
   * built the same way.
   */
  taxable: number;
  /**
   * The rate frozen at sale time. `null` means the line predates the snapshot
   * (3.8); `0` is a real rate — zero-rated, or an exempt product — and is not
   * the same fact.
   */
  taxRatePercent: number | null;
}

/** One row of a printed breakdown. */
export interface TaxBreakdownRow {
  ratePercent: number;
  /** The net the rate was applied to. */
  taxable: number;
  /** This rate's share of the recorded total. Rows sum to it exactly. */
  taxAmount: number;
}

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/** One line's weight in the allocation. */
export function taxWeight(taxable: number, ratePercent: number): number {
  return taxable * ratePercent;
}

/**
 * Σ of every line's weight, or `null` when any line lacks a rate.
 *
 * Null is deliberate rather than a zero: a sale is wholly pre-3.8 or wholly
 * post (3.9 writes a rate on every line), so one missing rate makes the whole
 * weight unusable and the caller must fall back to its previous method.
 */
export function totalTaxWeight(lines: readonly TaxableLine[]): number | null {
  if (lines.some((l) => l.taxRatePercent === null)) return null;
  return lines.reduce((acc, l) => acc + taxWeight(l.taxable, l.taxRatePercent!), 0);
}

/**
 * The rows a document should print, or `[]` when it should print none.
 *
 * Returns nothing — meaning "render exactly what you rendered before" — when:
 *
 *   • there are no lines. A RESTAURANT Sale carries none: `closeSession` writes
 *     totals only and the lines live on the session's orders. Their bill is
 *     untouched by this feature, which is a stronger guarantee than matching.
 *   • any line lacks a rate, i.e. the sale predates 3.8.
 *   • **every line shares one rate.** A breakdown that repeats the single total
 *     already printed adds a row and no information, so a single-rate sale —
 *     every tenant today — takes the identical code path it took before. That
 *     is the zero-change guarantee, enforced here rather than in four renderers
 *     that could each drift.
 *
 * A ZERO-RATED row IS returned when other rates exist. Proving an item was
 * zero-rated is often a legal requirement, and it is the line a shopper looks
 * for when a price seems wrong (PO, 2026-09-02).
 */
export function taxBreakdownForDocument(
  lines: readonly TaxableLine[],
  recordedTax: number,
): TaxBreakdownRow[] {
  if (lines.length === 0) return [];

  const weightTotal = totalTaxWeight(lines);
  if (weightTotal === null) return [];

  const rates = [...new Set(lines.map((l) => l.taxRatePercent!))];
  if (rates.length <= 1) return [];

  // Highest rate first: the standard rate is what a reader checks, and a
  // deterministic order keeps the rendered document stable between prints.
  rates.sort((a, b) => b - a);

  const rows = rates.map((ratePercent) => {
    const forRate = lines.filter((l) => l.taxRatePercent === ratePercent);
    const taxable = round2(forRate.reduce((acc, l) => acc + l.taxable, 0));
    const weight = forRate.reduce((acc, l) => acc + taxWeight(l.taxable, l.taxRatePercent!), 0);
    const taxAmount =
      weightTotal > 0 ? round2((recordedTax * weight) / weightTotal) : 0;
    return { ratePercent, taxable, taxAmount };
  });

  /*
   * The printed rows must add up to the printed total. Each row was rounded
   * independently, so their sum can miss by a cent; the largest row absorbs the
   * difference, where it distorts least.
   *
   * Absorbing is legitimate HERE and was not for returns: a document shows the
   * whole partition at once, so there is always a row to carry the remainder.
   * A refund sees one line at a time and may be split across weeks, which is
   * why 3.11 allocates instead — a line cannot know it is the last.
   */
  const drift = round2(recordedTax - rows.reduce((acc, r) => acc + r.taxAmount, 0));
  if (drift !== 0 && rows.length > 0) {
    const largest = rows.reduce((a, b) => (b.taxAmount > a.taxAmount ? b : a));
    largest.taxAmount = round2(largest.taxAmount + drift);
  }

  return rows;
}

/** `18%` — the label a rate is printed under. Trailing zeros dropped. */
export function taxRateLabel(ratePercent: number): string {
  return `${Number(ratePercent.toFixed(2))}%`;
}
