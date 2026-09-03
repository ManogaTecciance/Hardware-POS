/**
 * D102 (4.2) — the promotion applier's arithmetic.
 *
 * ## Why this spec lives here and not in `packages/shared`
 *
 * `shared` has no test runner and no test script — `money.ts`, `tax-breakdown.ts`
 * and `sale-line-label.ts` are all exercised from this suite for the same reason.
 * Adding vitest to a package three apps consume is infrastructure, not a step in
 * this phase, so the applier follows the convention already in place.
 *
 * ## What makes these assertions non-vacuous (D30)
 *
 * Every distribution case asserts the PARTS and their SUM. A test that checked
 * only the sum would pass for a function that dumped the whole amount on line
 * one; a test that checked only the parts would pass for one that lost a cent.
 *
 * The BOGO cases assert the discount lands on the RIGHT LINE, not merely that
 * some discount appeared — putting the tie's 500 on a shirt would still total
 * 500 and would still refund wrongly, which is the defect D102 exists to prevent.
 */
import {
  applyPromotions,
  distributeByLargestRemainder,
  type PromotionCartLine,
  type PromotionRule,
} from '@hardware-pos/shared';

const line = (over: Partial<PromotionCartLine> & { id: string }): PromotionCartLine => ({
  productId: over.productId ?? over.id,
  unitPrice: 0,
  quantity: 1,
  lineSubtotal: 0,
  manualDiscountAmount: 0,
  ...over,
});

/** A line whose subtotal is derived, so a fixture cannot state an impossible one. */
const item = (
  id: string,
  productId: string,
  unitPrice: number,
  quantity = 1,
  manualDiscountAmount = 0,
): PromotionCartLine =>
  line({
    id,
    productId,
    unitPrice,
    quantity,
    lineSubtotal: Math.round(unitPrice * quantity * 100) / 100,
    manualDiscountAmount,
  });

const rule = (over: Partial<PromotionRule> & { id: string; type: PromotionRule['type'] }): PromotionRule => ({
  name: `Promo ${over.id}`,
  fixedPrice: null,
  percentageOff: null,
  amountOff: null,
  buyQuantity: null,
  getQuantity: null,
  items: [],
  ...over,
});

const sum = (ns: readonly number[]) => Math.round(ns.reduce((a, b) => a + b, 0) * 100) / 100;
const byLine = (r: ReturnType<typeof applyPromotions>) =>
  Object.fromEntries(r.lines.map((l) => [l.lineId, l.discountAmount]));

// ─────────────────────────────────────────────────────────────────────────────
// The distribution primitive
// ─────────────────────────────────────────────────────────────────────────────

describe('distributeByLargestRemainder', () => {
  it('splits an indivisible amount so the parts still sum to the whole', () => {
    const parts = distributeByLargestRemainder(10, [1, 1, 1]);

    // The PARTS: rounding each share independently would give 3.33 three times.
    expect(parts).toEqual([3.34, 3.33, 3.33]);
    // …and the SUM. Both, because either alone passes for a broken function.
    expect(sum(parts)).toBe(10);
  });

  it('weights the split by line value, not by line count', () => {
    const parts = distributeByLargestRemainder(200, [400, 400, 400]);

    expect(parts).toEqual([66.67, 66.67, 66.66]);
    expect(sum(parts)).toBe(200);
  });

  it('gives the leftover cent to the largest fractional share, not the first line', () => {
    // Weights 1:1:8. The 80% share carries the largest remainder.
    const parts = distributeByLargestRemainder(1, [1, 1, 8]);

    expect(sum(parts)).toBe(1);
    expect(parts[2]).toBeGreaterThan(parts[0]!);
  });

  it('is deterministic — the same basket prices the same on any till', () => {
    const a = distributeByLargestRemainder(10, [1, 1, 1]);
    const b = distributeByLargestRemainder(10, [1, 1, 1]);

    expect(a).toEqual(b);
  });

  it('returns zeros rather than dumping the amount when there is no weight', () => {
    // NEGATIVE: the degenerate input must not put 10.00 on line one.
    expect(distributeByLargestRemainder(10, [0, 0])).toEqual([0, 0]);
    expect(distributeByLargestRemainder(0, [1, 1])).toEqual([0, 0]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PERCENTAGE_DISCOUNT
// ─────────────────────────────────────────────────────────────────────────────

describe('PERCENTAGE_DISCOUNT', () => {
  it('takes the percentage off each named line and leaves the others alone', () => {
    const lines = [item('l1', 'p_shirt', 1000), item('l2', 'p_tie', 500)];
    const promo = rule({
      id: 'r1',
      type: 'PERCENTAGE_DISCOUNT',
      percentageOff: 10,
      items: [{ productId: 'p_shirt', role: 'BUNDLE', quantity: 1 }],
    });

    const result = applyPromotions({ lines, promotions: [promo] });

    // POSITIVE: the named line is discounted…
    expect(byLine(result)).toEqual({ l1: 100 });
    // NEGATIVE: …and the unnamed one is untouched, not discounted by zero.
    expect(result.lines.map((l) => l.lineId)).not.toContain('l2');
    expect(result.totalDiscount).toBe(100);
  });

  it('rounds a fractional percentage to the cent', () => {
    const lines = [item('l1', 'p', 333.33)];
    const promo = rule({
      id: 'r1',
      type: 'PERCENTAGE_DISCOUNT',
      percentageOff: 7.5,
      items: [{ productId: 'p', role: 'BUNDLE', quantity: 1 }],
    });

    // 333.33 × 7.5% = 24.99975 → 25.00
    expect(byLine(applyPromotions({ lines, promotions: [promo] }))).toEqual({ l1: 25 });
  });

  it('never discounts more than the goods cost', () => {
    const lines = [item('l1', 'p', 100)];
    const promo = rule({
      id: 'r1',
      type: 'PERCENTAGE_DISCOUNT',
      percentageOff: 150,
      items: [{ productId: 'p', role: 'BUNDLE', quantity: 1 }],
    });

    expect(byLine(applyPromotions({ lines, promotions: [promo] }))).toEqual({ l1: 100 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FIXED_AMOUNT_DISCOUNT
// ─────────────────────────────────────────────────────────────────────────────

describe('FIXED_AMOUNT_DISCOUNT', () => {
  it('spreads one cash amount across the named lines, to the cent', () => {
    const lines = [item('l1', 'a', 100), item('l2', 'b', 100), item('l3', 'c', 100)];
    const promo = rule({
      id: 'r1',
      type: 'FIXED_AMOUNT_DISCOUNT',
      amountOff: 10,
      items: ['a', 'b', 'c'].map((productId) => ({ productId, role: 'BUNDLE' as const, quantity: 1 })),
    });

    const result = applyPromotions({ lines, promotions: [promo] });

    expect(byLine(result)).toEqual({ l1: 3.34, l2: 3.33, l3: 3.33 });
    // The customer was promised 10 off and is given exactly 10 off.
    expect(result.totalDiscount).toBe(10);
  });

  it('weights the spread by line value', () => {
    const lines = [item('l1', 'a', 900), item('l2', 'b', 100)];
    const promo = rule({
      id: 'r1',
      type: 'FIXED_AMOUNT_DISCOUNT',
      amountOff: 100,
      items: ['a', 'b'].map((productId) => ({ productId, role: 'BUNDLE' as const, quantity: 1 })),
    });

    const result = applyPromotions({ lines, promotions: [promo] });

    expect(byLine(result)).toEqual({ l1: 90, l2: 10 });
    expect(result.totalDiscount).toBe(100);
  });

  it('caps at the goods — 500 off 300 of stock discounts 300, not 500', () => {
    const lines = [item('l1', 'a', 300)];
    const promo = rule({
      id: 'r1',
      type: 'FIXED_AMOUNT_DISCOUNT',
      amountOff: 500,
      items: [{ productId: 'a', role: 'BUNDLE', quantity: 1 }],
    });

    // NEGATIVE: no 200 of credit is invented.
    expect(applyPromotions({ lines, promotions: [promo] }).totalDiscount).toBe(300);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// BUNDLE_FIXED_PRICE
// ─────────────────────────────────────────────────────────────────────────────

describe('BUNDLE_FIXED_PRICE', () => {
  const bundleOf = (ids: string[], fixedPrice: number) =>
    rule({
      id: 'r1',
      type: 'BUNDLE_FIXED_PRICE',
      fixedPrice,
      items: ids.map((productId) => ({ productId, role: 'BUNDLE' as const, quantity: 1 })),
    });

  it('distributes the saving across the bundled lines, to the cent', () => {
    // Three at 400 = 1,200 gross; bundle price 1,000; saving 200.
    const lines = [item('l1', 'a', 400), item('l2', 'b', 400), item('l3', 'c', 400)];

    const result = applyPromotions({ lines, promotions: [bundleOf(['a', 'b', 'c'], 1000)] });

    expect(byLine(result)).toEqual({ l1: 66.67, l2: 66.67, l3: 66.66 });
    expect(result.totalDiscount).toBe(200);
  });

  it('does not apply at all when the bundle is incomplete', () => {
    const lines = [item('l1', 'a', 400), item('l2', 'b', 400)];

    // NEGATIVE: two thirds of a bundle is a basket, not a discount.
    const result = applyPromotions({ lines, promotions: [bundleOf(['a', 'b', 'c'], 1000)] });

    expect(result.lines).toEqual([]);
    expect(result.totalDiscount).toBe(0);
  });

  it('applies twice when the cart holds two complete bundles', () => {
    const lines = [item('l1', 'a', 400, 2), item('l2', 'b', 400, 2), item('l3', 'c', 400, 2)];

    const result = applyPromotions({ lines, promotions: [bundleOf(['a', 'b', 'c'], 1000)] });

    // Gross consumed 2,400; two bundles at 1,000; saving 400.
    expect(result.totalDiscount).toBe(400);
  });

  it('discounts only the units a bundle consumes, not the whole line', () => {
    // Three of "a" but only one bundle can complete, so two stay full price.
    const lines = [item('l1', 'a', 400, 3), item('l2', 'b', 400), item('l3', 'c', 400)];

    const result = applyPromotions({ lines, promotions: [bundleOf(['a', 'b', 'c'], 1000)] });

    expect(result.totalDiscount).toBe(200);
  });

  it('is not a discount when the bundle price exceeds the goods', () => {
    const lines = [item('l1', 'a', 100), item('l2', 'b', 100)];

    // NEGATIVE: a badly configured bundle must not create a surcharge, and must
    // not silently apply a negative discount.
    const result = applyPromotions({ lines, promotions: [bundleOf(['a', 'b'], 500)] });

    expect(result.lines).toEqual([]);
    expect(result.totalDiscount).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// BUY_X_GET_Y — the case D102 was written around
// ─────────────────────────────────────────────────────────────────────────────

describe('BUY_X_GET_Y', () => {
  it('puts the whole saving on the FREE item — the D102 worked example', () => {
    // Two shirts at 1,000 and a tie at 500, tie free. The customer pays 2,000.
    const lines = [item('l_shirt', 'p_shirt', 1000, 2), item('l_tie', 'p_tie', 500)];
    const promo = rule({
      id: 'r1',
      type: 'BUY_X_GET_Y',
      buyQuantity: 2,
      getQuantity: 1,
      items: [
        { productId: 'p_shirt', role: 'BUY', quantity: 1 },
        { productId: 'p_tie', role: 'GET', quantity: 1 },
      ],
    });

    const result = applyPromotions({ lines, promotions: [promo] });

    /*
     * The whole 500 sits on the tie, so `lineTotal` for that line is 0 and a
     * return of the tie refunds nothing. Spreading it across the basket by value
     * would give the tie only 100 and refund 400 on a free item — the defect
     * D102 exists to prevent, and the reason this asserts the LINE and not just
     * the total.
     */
    expect(byLine(result)).toEqual({ l_tie: 500 });
    expect(result.lines.map((l) => l.lineId)).not.toContain('l_shirt');
    expect(result.totalDiscount).toBe(500);
  });

  it('does not apply when the buy threshold is not met', () => {
    const lines = [item('l_shirt', 'p_shirt', 1000, 1), item('l_tie', 'p_tie', 500)];
    const promo = rule({
      id: 'r1',
      type: 'BUY_X_GET_Y',
      buyQuantity: 2,
      getQuantity: 1,
      items: [
        { productId: 'p_shirt', role: 'BUY', quantity: 1 },
        { productId: 'p_tie', role: 'GET', quantity: 1 },
      ],
    });

    expect(applyPromotions({ lines, promotions: [promo] }).lines).toEqual([]);
  });

  it('frees the CHEAPEST qualifying unit when the reward lines differ in price', () => {
    const lines = [
      item('l_shirt', 'p_shirt', 1000, 2),
      item('l_tie_cheap', 'p_tie', 300),
      item('l_tie_rich', 'p_tie2', 900),
    ];
    const promo = rule({
      id: 'r1',
      type: 'BUY_X_GET_Y',
      buyQuantity: 2,
      getQuantity: 1,
      items: [
        { productId: 'p_shirt', role: 'BUY', quantity: 1 },
        { productId: 'p_tie', role: 'GET', quantity: 1 },
        { productId: 'p_tie2', role: 'GET', quantity: 1 },
      ],
    });

    const result = applyPromotions({ lines, promotions: [promo] });

    // The documented rule, asserted both ways so a flip to dearest-first fails.
    expect(byLine(result)).toEqual({ l_tie_cheap: 300 });
    expect(result.lines.map((l) => l.lineId)).not.toContain('l_tie_rich');
  });

  it('same-product BOGO needs X + Y units, not X', () => {
    const promo = rule({
      id: 'r1',
      type: 'BUY_X_GET_Y',
      buyQuantity: 2,
      getQuantity: 1,
      items: [
        { productId: 'p', role: 'BUY', quantity: 1 },
        { productId: 'p', role: 'GET', quantity: 1 },
      ],
    });

    // NEGATIVE: two in the cart is not yet "buy two get one" — freeing a unit
    // here gives away a third the customer never had.
    expect(applyPromotions({ lines: [item('l1', 'p', 100, 2)], promotions: [promo] }).lines).toEqual(
      [],
    );

    // POSITIVE: three in the cart frees exactly one.
    expect(
      applyPromotions({ lines: [item('l1', 'p', 100, 3)], promotions: [promo] }).totalDiscount,
    ).toBe(100);

    // …and six frees two, not three.
    expect(
      applyPromotions({ lines: [item('l1', 'p', 100, 6)], promotions: [promo] }).totalDiscount,
    ).toBe(200);
  });

  it('never frees more reward units than the customer is holding', () => {
    const lines = [item('l_shirt', 'p_shirt', 1000, 10), item('l_tie', 'p_tie', 500, 1)];
    const promo = rule({
      id: 'r1',
      type: 'BUY_X_GET_Y',
      buyQuantity: 2,
      getQuantity: 1,
      items: [
        { productId: 'p_shirt', role: 'BUY', quantity: 1 },
        { productId: 'p_tie', role: 'GET', quantity: 1 },
      ],
    });

    // Five applications earned, one tie held: one tie free, not five.
    expect(applyPromotions({ lines, promotions: [promo] }).totalDiscount).toBe(500);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Basket-level rules
// ─────────────────────────────────────────────────────────────────────────────

describe('the basket rules D102 fixed', () => {
  const tenPercentOff = (id: string, productId: string) =>
    rule({
      id,
      type: 'PERCENTAGE_DISCOUNT',
      percentageOff: 10,
      items: [{ productId, role: 'BUNDLE', quantity: 1 }],
    });

  it('a manually discounted line is invisible to promotions', () => {
    const lines = [item('l1', 'p', 1000, 1, 50)];

    // NEGATIVE: manual wins, so the promotion finds nothing…
    expect(applyPromotions({ lines, promotions: [tenPercentOff('r1', 'p')] }).lines).toEqual([]);

    // POSITIVE CONTROL: the identical basket without the manual discount does
    // get the promotion, so the negative above is about precedence and not a
    // fixture that never qualified.
    const clean = [item('l1', 'p', 1000)];
    expect(applyPromotions({ lines: clean, promotions: [tenPercentOff('r1', 'p')] }).totalDiscount).toBe(
      100,
    );
  });

  it('a manually discounted line cannot complete a bundle either', () => {
    const lines = [item('l1', 'a', 400), item('l2', 'b', 400), item('l3', 'c', 400, 1, 10)];
    const bundle = rule({
      id: 'r1',
      type: 'BUNDLE_FIXED_PRICE',
      fixedPrice: 1000,
      items: ['a', 'b', 'c'].map((productId) => ({ productId, role: 'BUNDLE' as const, quantity: 1 })),
    });

    expect(applyPromotions({ lines, promotions: [bundle] }).lines).toEqual([]);
  });

  it('one promotion per line — the larger wins, because SaleItem holds one id', () => {
    const lines = [item('l1', 'p', 1000)];
    const small = tenPercentOff('r_small', 'p');
    const large = rule({
      id: 'r_large',
      type: 'PERCENTAGE_DISCOUNT',
      percentageOff: 25,
      items: [{ productId: 'p', role: 'BUNDLE', quantity: 1 }],
    });

    const result = applyPromotions({ lines, promotions: [small, large] });

    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]!.promotionId).toBe('r_large');
    expect(result.totalDiscount).toBe(250);
  });

  it('order of the promotions array does not change the bill', () => {
    const lines = [item('l1', 'p', 1000)];
    const small = tenPercentOff('r_small', 'p');
    const large = rule({
      id: 'r_large',
      type: 'PERCENTAGE_DISCOUNT',
      percentageOff: 25,
      items: [{ productId: 'p', role: 'BUNDLE', quantity: 1 }],
    });

    const forward = applyPromotions({ lines, promotions: [small, large] });
    const reversed = applyPromotions({ lines, promotions: [large, small] });

    expect(forward).toEqual(reversed);
  });

  it('a bundle is skipped whole rather than applied in part', () => {
    // The percentage promotion is worth more and claims l1 first, which leaves
    // the bundle unable to take every line it needs.
    const lines = [item('l1', 'a', 1000), item('l2', 'b', 100), item('l3', 'c', 100)];
    const rich = rule({
      id: 'r_rich',
      type: 'PERCENTAGE_DISCOUNT',
      percentageOff: 50,
      items: [{ productId: 'a', role: 'BUNDLE', quantity: 1 }],
    });
    const bundle = rule({
      id: 'r_bundle',
      type: 'BUNDLE_FIXED_PRICE',
      fixedPrice: 1000,
      items: ['a', 'b', 'c'].map((productId) => ({ productId, role: 'BUNDLE' as const, quantity: 1 })),
    });

    const result = applyPromotions({ lines, promotions: [rich, bundle] });

    // POSITIVE: the richer promotion applied…
    expect(byLine(result)).toEqual({ l1: 500 });
    // NEGATIVE: …and no half-bundle leaked onto l2 or l3, which would be a
    // wrong discount rather than a smaller one.
    expect(result.lines.map((l) => l.lineId).sort()).toEqual(['l1']);
  });

  it('an empty basket and an empty promotion list both produce nothing', () => {
    expect(applyPromotions({ lines: [], promotions: [] })).toEqual({ lines: [], totalDiscount: 0 });
    expect(
      applyPromotions({ lines: [item('l1', 'p', 100)], promotions: [] }).totalDiscount,
    ).toBe(0);
  });
});
