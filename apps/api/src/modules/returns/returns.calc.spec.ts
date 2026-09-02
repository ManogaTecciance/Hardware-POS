import { computeReturnLine, sumReturnTotals, type OriginalSaleSnapshot } from './returns.calc';

/** A sale with no order discount and no tax. */
const PLAIN_SALE: OriginalSaleSnapshot = {
  subtotal: 400,
  totalDiscount: 0,
  orderDiscountAmount: 0,
  taxAmount: 0,
  // D101 (3.11) — null marks a sale written BEFORE per-line rates existed, so
  // every assertion in this file exercises the proportional FALLBACK. That is
  // deliberate: these numbers are what historical sales refunded, and they must
  // not move. No assertion in this file was edited (D16); only the fixtures now
  // say which case they are.
  taxWeightTotal: null,
};

describe('computeReturnLine', () => {
  it('refunds the original price for a partial return with no discounts or tax', () => {
    const line = computeReturnLine(
      PLAIN_SALE,
      { unitPrice: 100, purchasedQuantity: 4, discountAmount: 0, lineTotal: 400, taxRatePercent: null },
      2,
    );
    expect(line.originalLineSubtotal).toBe(200);
    expect(line.productDiscountAdjustment).toBe(0);
    expect(line.orderDiscountAdjustment).toBe(0);
    expect(line.taxAdjustment).toBe(0);
    expect(line.refundableAmount).toBe(200);
  });

  it('applies the product discount proportionally', () => {
    // 100 × 4 with a 40 (10%) line discount → lineTotal 360.
    const line = computeReturnLine(
      { subtotal: 400, totalDiscount: 40, orderDiscountAmount: 0, taxAmount: 0, taxWeightTotal: null },
      { unitPrice: 100, purchasedQuantity: 4, discountAmount: 40, lineTotal: 360, taxRatePercent: null },
      2,
    );
    expect(line.originalLineSubtotal).toBe(200);
    expect(line.productDiscountAdjustment).toBe(20); // half of 40
    expect(line.refundableAmount).toBe(180); // 200 - 20
  });

  it('applies the order-level discount proportionally', () => {
    // 10% order discount (40) on a single 100×4 line.
    const line = computeReturnLine(
      { subtotal: 400, totalDiscount: 0, orderDiscountAmount: 40, taxAmount: 0, taxWeightTotal: null },
      { unitPrice: 100, purchasedQuantity: 4, discountAmount: 0, lineTotal: 400, taxRatePercent: null },
      2,
    );
    expect(line.orderDiscountAdjustment).toBe(20); // 40 × (200/400)
    expect(line.refundableAmount).toBe(180); // 200 - 20
  });

  it('reverses tax proportionally', () => {
    const line = computeReturnLine(
      { subtotal: 400, totalDiscount: 0, orderDiscountAmount: 0, taxAmount: 40, taxWeightTotal: null },
      { unitPrice: 100, purchasedQuantity: 4, discountAmount: 0, lineTotal: 400, taxRatePercent: null },
      2,
    );
    expect(line.taxAdjustment).toBe(20); // 40 × (200/400)
    expect(line.refundableAmount).toBe(220); // 200 + 20
  });

  it('combines product discount, order discount, and tax for a half-line return', () => {
    // Sale: two lines. Line1 100×2 with a 20 line discount (lineTotal 180).
    // discountedSubtotal 380, order discount 38 (10%), tax 34.20 (10% of 342).
    const sale: OriginalSaleSnapshot = {
      subtotal: 400,
      totalDiscount: 20,
      orderDiscountAmount: 38,
      taxAmount: 34.2,
      taxWeightTotal: null,
    };
    const line = computeReturnLine(
      sale,
      { unitPrice: 100, purchasedQuantity: 2, discountAmount: 20, lineTotal: 180, taxRatePercent: null },
      1,
    );
    expect(line.originalLineSubtotal).toBe(100);
    expect(line.productDiscountAdjustment).toBe(10); // 20 × 0.5
    expect(line.orderDiscountAdjustment).toBe(9); // (38 × 180/380) × 0.5 = 9
    expect(line.taxAdjustment).toBe(8.1); // (34.2 × 162/342) × 0.5 = 8.1
    expect(line.refundableAmount).toBe(89.1); // 90 - 9 + 8.1
  });
});

describe('sumReturnTotals — full sale return equals the sale total', () => {
  it('sums per-line refunds to exactly the original total', () => {
    const sale: OriginalSaleSnapshot = {
      subtotal: 400,
      totalDiscount: 20,
      orderDiscountAmount: 38,
      taxAmount: 34.2,
      taxWeightTotal: null,
    };
    const line1 = computeReturnLine(
      sale,
      { unitPrice: 100, purchasedQuantity: 2, discountAmount: 20, lineTotal: 180, taxRatePercent: null },
      2,
    );
    const line2 = computeReturnLine(
      sale,
      { unitPrice: 100, purchasedQuantity: 2, discountAmount: 0, lineTotal: 200, taxRatePercent: null },
      2,
    );
    const totals = sumReturnTotals([line1, line2]);
    expect(totals.subtotal).toBe(400);
    expect(totals.productDiscountAdjustment).toBe(20);
    expect(totals.orderDiscountAdjustment).toBe(38);
    expect(totals.taxAdjustment).toBe(34.2);
    // The whole point: a full return refunds exactly what the customer paid.
    expect(totals.refundTotal).toBe(376.2); // 400 - 20 - 38 + 34.2
  });

  it('aggregates a multi-item partial return', () => {
    const line1 = computeReturnLine(
      PLAIN_SALE,
      { unitPrice: 100, purchasedQuantity: 4, discountAmount: 0, lineTotal: 400, taxRatePercent: null },
      1,
    );
    const line2 = computeReturnLine(
      PLAIN_SALE,
      { unitPrice: 50, purchasedQuantity: 2, discountAmount: 0, lineTotal: 100, taxRatePercent: null },
      2,
    );
    const totals = sumReturnTotals([line1, line2]);
    expect(totals.subtotal).toBe(200); // 100 + 100
    expect(totals.refundTotal).toBe(200);
  });
});

/**
 * D101 (3.11) — the snapshot path.
 *
 * Every test ABOVE uses `taxWeightTotal: null` and therefore exercises the
 * proportional fallback that pre-3.8 sales are refunded by. These pin the new
 * weighted allocation, and the first one proves the two agree.
 */
describe('weighted allocation — uniform rates converge on the old formula', () => {
  it('gives the identical answer the fallback gives', () => {
    // THE safety property. `rate` cancels top and bottom, so a sale where every
    // line is taxed the same must refund exactly what it refunded before.
    const line = {
      unitPrice: 100,
      purchasedQuantity: 4,
      discountAmount: 0,
      lineTotal: 400,
      taxRatePercent: 18,
    };
    const withSnapshot = computeReturnLine(
      { subtotal: 400, totalDiscount: 0, orderDiscountAmount: 0, taxAmount: 40, taxWeightTotal: 400 * 18 },
      line,
      2,
    );
    const fallback = computeReturnLine(
      { subtotal: 400, totalDiscount: 0, orderDiscountAmount: 0, taxAmount: 40, taxWeightTotal: null },
      { ...line, taxRatePercent: null },
      2,
    );

    expect(withSnapshot.taxAdjustment).toBe(fallback.taxAdjustment);
    // And it is the number the pre-existing spec pins: 40 × (200/400).
    expect(withSnapshot.taxAdjustment).toBe(20);
  });
});

describe('weighted allocation — a mixed basket', () => {
  /*
   * Fixture A 1000.00 taxed at 18%, fixture B 250.50 exempt.
   * 3.10 taxes only A, so the sale's tax is 180.00.
   * Weights: A = 1000 × 18 = 18000, B = 250.50 × 0 = 0.
   */
  const MIXED = {
    subtotal: 1250.5,
    totalDiscount: 0,
    orderDiscountAmount: 0,
    taxAmount: 180,
    taxWeightTotal: 1000 * 18,
  };

  it('refunds the taxable line everything it paid', () => {
    const line = computeReturnLine(
      MIXED,
      { unitPrice: 1000, purchasedQuantity: 1, discountAmount: 0, lineTotal: 1000, taxRatePercent: 18 },
      1,
    );

    expect(line.taxAdjustment).toBe(180);
    // What the OLD denominator would have given: 180 × 1000/1250.50 = 143.94.
    // Named so this test says what it prevents, not just what it expects.
    expect(line.taxAdjustment).not.toBe(143.94);
  });

  it('refunds the exempt line nothing', () => {
    const line = computeReturnLine(
      MIXED,
      { unitPrice: 250.5, purchasedQuantity: 1, discountAmount: 0, lineTotal: 250.5, taxRatePercent: 0 },
      1,
    );

    expect(line.taxAdjustment).toBe(0);
    // The old formula refunded 180 × 250.50/1250.50 = 36.06 — tax the customer
    // was never charged.
    expect(line.taxAdjustment).not.toBe(36.06);
  });

  it('the two together reconcile to the sale exactly', () => {
    const a = computeReturnLine(
      MIXED,
      { unitPrice: 1000, purchasedQuantity: 1, discountAmount: 0, lineTotal: 1000, taxRatePercent: 18 },
      1,
    );
    const b = computeReturnLine(
      MIXED,
      { unitPrice: 250.5, purchasedQuantity: 1, discountAmount: 0, lineTotal: 250.5, taxRatePercent: 0 },
      1,
    );

    expect(sumReturnTotals([a, b]).taxAdjustment).toBe(MIXED.taxAmount);
  });
});

describe('weighted allocation — split returns reconcile', () => {
  // The case that killed the "last item absorbs the remainder" idea: neither
  // half is a full return, so neither can know it should absorb anything. Under
  // allocation each half claims its own fixed share and they add up regardless.
  const SALE = {
    subtotal: 1000,
    totalDiscount: 0,
    orderDiscountAmount: 0,
    taxAmount: 180,
    taxWeightTotal: 1000 * 18,
  };
  const LINE = {
    unitPrice: 250,
    purchasedQuantity: 4,
    discountAmount: 0,
    lineTotal: 1000,
    taxRatePercent: 18,
  };

  it('two halves sum to the whole', () => {
    const first = computeReturnLine(SALE, LINE, 2);
    const second = computeReturnLine(SALE, LINE, 2);

    expect(first.taxAdjustment).toBe(90);
    expect(second.taxAdjustment).toBe(90);
    expect(first.taxAdjustment + second.taxAdjustment).toBe(SALE.taxAmount);
  });

  it('four singles sum to the whole', () => {
    const singles = [1, 1, 1, 1].map((q) => computeReturnLine(SALE, LINE, q));

    expect(sumReturnTotals(singles).taxAdjustment).toBe(SALE.taxAmount);
  });
});

describe('weighted allocation — degenerate inputs refuse rather than divide', () => {
  it('an all-exempt sale with recorded tax refunds no tax', () => {
    // taxWeightTotal 0 would be a division by zero. It should not be reachable
    // — 3.10 charges no tax when everything is exempt — but a guard that only
    // holds while another module behaves is not a guard.
    const line = computeReturnLine(
      { subtotal: 400, totalDiscount: 0, orderDiscountAmount: 0, taxAmount: 40, taxWeightTotal: 0 },
      { unitPrice: 100, purchasedQuantity: 4, discountAmount: 0, lineTotal: 400, taxRatePercent: 0 },
      2,
    );

    expect(line.taxAdjustment).toBe(0);
    expect(Number.isFinite(line.refundableAmount)).toBe(true);
  });

  it('a sale with no tax refunds none whichever path it takes', () => {
    for (const weight of [null, 7200]) {
      const line = computeReturnLine(
        { subtotal: 400, totalDiscount: 0, orderDiscountAmount: 0, taxAmount: 0, taxWeightTotal: weight },
        { unitPrice: 100, purchasedQuantity: 4, discountAmount: 0, lineTotal: 400, taxRatePercent: 18 },
        2,
      );
      expect(line.taxAdjustment).toBe(0);
    }
  });
});
