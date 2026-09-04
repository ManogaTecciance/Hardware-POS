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
  outstandingRewards,
  rewardEntitlements,
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
  minimumSpend: null,
  buyQuantity: null,
  getQuantity: null,
  // Mirrors `Promotion.stackable`'s own default, so a fixture never describes a
  // promotion the database could not produce.
  stackable: false,
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
      // Explicitly free. Left implicit, these cases passed against a broken
      // applier that ignored the field entirely.
      percentageOff: 100,
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

  it('honours the discount ON THE REWARD, not just "free"', () => {
    /*
     * The defect this case exists for. The promotion editor collects
     * `percentageOff` as "the discount on the Get item (100 = free)", and the
     * applier ignored it — every BOGO gave the reward away at full value. A shop
     * running "buy 2, get the 3rd half price" was handing it over for nothing.
     *
     * Every earlier BOGO case here used a free reward, which is exactly the one
     * value where the broken code was right. The fixture hid the bug.
     */
    const lines = [item('l_shirt', 'p_shirt', 1000, 2), item('l_tie', 'p_tie', 500)];
    const halfOff = rule({
      id: 'r1',
      type: 'BUY_X_GET_Y',
      buyQuantity: 2,
      getQuantity: 1,
      percentageOff: 50,
      items: [
        { productId: 'p_shirt', role: 'BUY', quantity: 1 },
        { productId: 'p_tie', role: 'GET', quantity: 1 },
      ],
    });

    // POSITIVE: half of 500, on the reward line.
    expect(byLine(applyPromotions({ lines, promotions: [halfOff] }))).toEqual({ l_tie: 250 });

    // POSITIVE CONTROL: 100 still means free, so the D102 case is unchanged.
    const free = rule({ ...halfOff, id: 'r2', percentageOff: 100 });
    expect(byLine(applyPromotions({ lines, promotions: [free] }))).toEqual({ l_tie: 500 });
  });

  it('treats a missing percentage as FREE — every row written before 4.7', () => {
    const lines = [item('l_shirt', 'p_shirt', 1000, 2), item('l_tie', 'p_tie', 500)];
    const legacy = rule({
      id: 'r1',
      type: 'BUY_X_GET_Y',
      buyQuantity: 2,
      getQuantity: 1,
      percentageOff: null,
      items: [
        { productId: 'p_shirt', role: 'BUY', quantity: 1 },
        { productId: 'p_tie', role: 'GET', quantity: 1 },
      ],
    });

    // `?? 100`. A null percentage meant a giveaway before this was read, and it
    // still does — no stored promotion changes meaning.
    expect(byLine(applyPromotions({ lines, promotions: [legacy] }))).toEqual({ l_tie: 500 });
  });

  it('rounds the reward discount to the cent, per unit', () => {
    // 333.33 at 33% = 109.9989 -> 110.00, and two rewarded units earn it twice.
    const lines = [item('l_buy', 'p_buy', 100, 4), item('l_get', 'p_get', 333.33, 2)];
    const promo = rule({
      id: 'r1',
      type: 'BUY_X_GET_Y',
      buyQuantity: 2,
      getQuantity: 1,
      percentageOff: 33,
      items: [
        { productId: 'p_buy', role: 'BUY', quantity: 1 },
        { productId: 'p_get', role: 'GET', quantity: 1 },
      ],
    });

    expect(byLine(applyPromotions({ lines, promotions: [promo] }))).toEqual({ l_get: 220 });
  });

  it('does not apply when the buy threshold is not met', () => {
    const lines = [item('l_shirt', 'p_shirt', 1000, 1), item('l_tie', 'p_tie', 500)];
    const promo = rule({
      id: 'r1',
      type: 'BUY_X_GET_Y',
      buyQuantity: 2,
      getQuantity: 1,
      // Explicitly free. Left implicit, these cases passed against a broken
      // applier that ignored the field entirely.
      percentageOff: 100,
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
      // Explicitly free. Left implicit, these cases passed against a broken
      // applier that ignored the field entirely.
      percentageOff: 100,
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
      // Explicitly free. Left implicit, these cases passed against a broken
      // applier that ignored the field entirely.
      percentageOff: 100,
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
      // Explicitly free. Left implicit, these cases passed against a broken
      // applier that ignored the field entirely.
      percentageOff: 100,
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
    // Exact object, deliberately: this is the assertion that notices a new
    // field appearing on the result, which is how D105's `orderPromotion` was
    // caught the moment it shipped rather than by a later surprise.
    expect(applyPromotions({ lines: [], promotions: [] })).toEqual({
      lines: [],
      totalDiscount: 0,
      orderPromotion: null,
    });
    expect(
      applyPromotions({ lines: [item('l1', 'p', 100)], promotions: [] }).totalDiscount,
    ).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// stackable — basket-level exclusivity (4.4)
// ─────────────────────────────────────────────────────────────────────────────

describe('stackable', () => {
  const pct = (id: string, productId: string, percentageOff: number, stackable: boolean) =>
    rule({
      id,
      type: 'PERCENTAGE_DISCOUNT',
      percentageOff,
      stackable,
      items: [{ productId, role: 'BUNDLE', quantity: 1 }],
    });

  it('a NON-stackable winner locks the basket, even on untouched lines', () => {
    const lines = [item('l1', 'a', 1000), item('l2', 'b', 1000)];
    const winner = pct('r_win', 'a', 50, false); // 500 — the larger
    const other = pct('r_other', 'b', 10, true); // 100, different line

    const result = applyPromotions({ lines, promotions: [winner, other] });

    // POSITIVE: the winner applied…
    expect(byLine(result)).toEqual({ l1: 500 });
    // NEGATIVE: …and locked the basket, so l2 got nothing despite being free and
    // its promotion being stackable. Exclusivity is basket-level, not line-level.
    expect(result.lines.map((l) => l.lineId)).not.toContain('l2');
  });

  it('a stackable winner lets other STACKABLE promotions join on other lines', () => {
    const lines = [item('l1', 'a', 1000), item('l2', 'b', 1000)];
    const winner = pct('r_win', 'a', 50, true); // 500
    const joiner = pct('r_join', 'b', 10, true); // 100

    const result = applyPromotions({ lines, promotions: [winner, joiner] });

    expect(byLine(result)).toEqual({ l1: 500, l2: 100 });
    expect(result.totalDiscount).toBe(600);
  });

  it('a stackable winner still shuts out a NON-stackable follower', () => {
    const lines = [item('l1', 'a', 1000), item('l2', 'b', 1000)];
    const winner = pct('r_win', 'a', 50, true); // 500
    const follower = pct('r_follow', 'b', 10, false); // 100, not stackable

    const result = applyPromotions({ lines, promotions: [winner, follower] });

    // POSITIVE CONTROL: the identical basket with a STACKABLE follower does give
    // l2 its 100 (asserted above), so this negative is about the flag and not a
    // fixture that never qualified.
    expect(byLine(result)).toEqual({ l1: 500 });
  });

  it('a lone non-stackable promotion still applies', () => {
    const lines = [item('l1', 'a', 1000)];

    // The flag restricts COMPANY, not the promotion itself.
    expect(applyPromotions({ lines, promotions: [pct('r1', 'a', 25, false)] }).totalDiscount).toBe(
      250,
    );
  });

  it('the flag does not change the deterministic order', () => {
    const lines = [item('l1', 'a', 1000), item('l2', 'b', 1000)];
    const a = pct('r_a', 'a', 50, true);
    const b = pct('r_b', 'b', 10, true);

    expect(applyPromotions({ lines, promotions: [a, b] })).toEqual(
      applyPromotions({ lines, promotions: [b, a] }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// pendingRewards — what the till adds for the customer (4.11)
// ─────────────────────────────────────────────────────────────────────────────

describe('rewardEntitlements', () => {
  const bogo = (over: Partial<PromotionRule> = {}) =>
    rule({
      id: 'r_bogo',
      name: 'Buy 2 shirts, tie free',
      type: 'BUY_X_GET_Y',
      buyQuantity: 2,
      getQuantity: 1,
      percentageOff: 100,
      items: [
        { productId: 'p_shirt', role: 'BUY', quantity: 1 },
        { productId: 'p_tie', role: 'GET', quantity: 1 },
      ],
      ...over,
    });

  it('asks for the reward when the threshold is met and it is missing', () => {
    // The reported case: two shirts in the basket, no tie, no discount — because
    // the applier discounts a reward the customer HOLDS.
    const lines = [item('l_shirt', 'p_shirt', 1000, 2)];

    expect(rewardEntitlements({ lines, promotions: [bogo()] })).toEqual([
      {
        promotionId: 'r_bogo',
        promotionName: 'Buy 2 shirts, tie free',
        productId: 'p_tie',
        earned: 1,
        held: 0,
      },
    ]);
  });

  it('reports the reward as HELD once it is in the basket — the loop guard', () => {
    /*
     * The property that makes auto-add terminate. The till adds the tie, this
     * runs again on the new basket, and finds nothing outstanding. Without it
     * the effect would add a tie on every render.
     */
    const lines = [item('l_shirt', 'p_shirt', 1000, 2), item('l_tie', 'p_tie', 500, 1)];

    // earned === held, so a caller has nothing to do and the effect settles.
    expect(rewardEntitlements({ lines, promotions: [bogo()] })[0]).toMatchObject({
      earned: 1,
      held: 1,
    });
  });

  it('FOUR shirts earn TWO ties — the reported case', () => {
    /*
     * 4.11 reported a shortfall and could only add, so once a tie line existed
     * nothing happened: four shirts stayed at one tie. Reporting the target
     * lets the caller top the line up.
     */
    const lines = [item('l_shirt', 'p_shirt', 1000, 4), item('l_tie', 'p_tie', 500, 1)];

    expect(rewardEntitlements({ lines, promotions: [bogo()] })[0]).toMatchObject({
      earned: 2,
      held: 1,
    });
  });

  it('reports ZERO below the threshold rather than staying silent', () => {
    /*
     * The other half of the reported case: dropping from two shirts to one must
     * WITHDRAW the tie. 4.11 omitted un-earned promotions entirely, so the
     * caller never learned to take it back and the customer was charged 500 for
     * a tie the till had put in their basket.
     */
    const lines = [item('l_shirt', 'p_shirt', 1000, 1), item('l_tie', 'p_tie', 500, 1)];

    expect(rewardEntitlements({ lines, promotions: [bogo()] })[0]).toMatchObject({
      earned: 0,
      held: 1,
    });
  });

  it('a manually discounted BUY line cannot earn a reward', () => {
    // Precedence (D102) holds here too: a discounted line is invisible to
    // promotions, so it cannot satisfy a threshold — and the till must not add
    // an item the applier would then charge for.
    const lines = [item('l_shirt', 'p_shirt', 1000, 2, 50)];

    // Reported as earning ZERO rather than omitted, so a reward the till had
    // already added is withdrawn when a cashier discounts the buy side.
    expect(rewardEntitlements({ lines, promotions: [bogo()] })[0]).toMatchObject({ earned: 0 });
  });

  it('same-product BOGO reports nothing — the reward IS the pool', () => {
    /*
     * "Buy 2 get 1 free" on ONE product: the customer must hold X + Y units for
     * an application, so by the time it earns anything it already holds the
     * reward. Adding another unit would earn nothing and charge for it.
     */
    const samePool = rule({
      id: 'r_same',
      type: 'BUY_X_GET_Y',
      buyQuantity: 2,
      getQuantity: 1,
      percentageOff: 100,
      items: [
        { productId: 'p', role: 'BUY', quantity: 1 },
        { productId: 'p', role: 'GET', quantity: 1 },
      ],
    });

    expect(rewardEntitlements({ lines: [item('l1', 'p', 100, 3)], promotions: [samePool] })).toEqual([]);
  });

  it('what it asks for is what the applier discounts — the agreement', () => {
    // The property that makes auto-add safe: add exactly what this returns, and
    // the applier prices it to zero. A line that appeared and was then charged
    // for would be worse than the offer never firing.
    const before = [item('l_shirt', 'p_shirt', 1000, 2)];
    const [ask] = rewardEntitlements({ lines: before, promotions: [bogo()] });
    expect(ask).toBeDefined();

    const after = [...before, item('l_tie', ask!.productId, 500, ask!.earned - ask!.held)];
    const result = applyPromotions({ lines: after, promotions: [bogo()] });

    expect(byLine(result)).toEqual({ l_tie: 500 });
  });

  it('ignores promotion types that grant no reward item', () => {
    const pct = rule({
      id: 'r_pct',
      type: 'PERCENTAGE_DISCOUNT',
      percentageOff: 10,
      items: [{ productId: 'p_shirt', role: 'BUNDLE', quantity: 1 }],
    });

    expect(rewardEntitlements({ lines: [item('l1', 'p_shirt', 1000, 5)], promotions: [pct] })).toEqual(
      [],
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// outstandingRewards — what the cashier is asked to add (4.14)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The till no longer adds the free item; it states what is owed and blocks
 * payment until the cashier has added it. These cases pin the count that drives
 * both the message and the gate.
 *
 * Nothing here names a shirt or a tie beyond the fixtures: a rule rewarding any
 * other product reads identically, because the promotion carries its own GET
 * product and this only reports the id.
 */
describe('outstandingRewards', () => {
  const offer = (buyProduct: string, getProduct: string, buyQty = 2, getQty = 1) =>
    rule({
      id: 'r_offer',
      name: 'Buy 2 Get 1',
      type: 'BUY_X_GET_Y',
      buyQuantity: buyQty,
      getQuantity: getQty,
      percentageOff: 100,
      items: [
        { productId: buyProduct, role: 'BUY', quantity: 1 },
        { productId: getProduct, role: 'GET', quantity: 1 },
      ],
    });

  it('asks for what is owed, naming the promotion and the reward product', () => {
    const lines = [item('l_buy', 'p_a', 1000, 2)];

    expect(outstandingRewards({ lines, promotions: [offer('p_a', 'p_b')] })).toEqual([
      {
        promotionId: 'r_offer',
        promotionName: 'Buy 2 Get 1',
        productId: 'p_b',
        earned: 1,
        held: 0,
        outstanding: 1,
      },
    ]);
  });

  it('scales with the qualifying quantity — 6 buys earn 3', () => {
    // Dynamic recalculation: the count follows the cart, with no quantity
    // written down anywhere.
    const lines = [item('l_buy', 'p_a', 1000, 6)];

    expect(outstandingRewards({ lines, promotions: [offer('p_a', 'p_b')] })[0]!.outstanding).toBe(3);
  });

  it('counts down as the cashier adds them, and clears at the last one', () => {
    const promo = [offer('p_a', 'p_b')];
    const withHeld = (n: number) =>
      outstandingRewards({
        lines: [item('l_buy', 'p_a', 1000, 6), ...(n > 0 ? [item('l_get', 'p_b', 500, n)] : [])],
        promotions: promo,
      });

    // 3 required: blocked at 0, 1 and 2 — allowed at 3.
    expect(withHeld(0)[0]!.outstanding).toBe(3);
    expect(withHeld(1)[0]!.outstanding).toBe(2);
    expect(withHeld(2)[0]!.outstanding).toBe(1);
    expect(withHeld(3)).toEqual([]);
  });

  it('reports nothing once satisfied — the payment gate opens', () => {
    const lines = [item('l_buy', 'p_a', 1000, 2), item('l_get', 'p_b', 500, 1)];

    expect(outstandingRewards({ lines, promotions: [offer('p_a', 'p_b')] })).toEqual([]);
  });

  it('reports nothing below the threshold — an offer not earned is not owed', () => {
    const lines = [item('l_buy', 'p_a', 1000, 1)];

    expect(outstandingRewards({ lines, promotions: [offer('p_a', 'p_b')] })).toEqual([]);
  });

  it('shrinks when the cashier reduces the qualifying quantity', () => {
    // The reported failure from the auto-add design, as a pure assertion: the
    // requirement must fall as well as rise.
    const promo = [offer('p_a', 'p_b')];

    expect(
      outstandingRewards({ lines: [item('l_buy', 'p_a', 1000, 4)], promotions: promo })[0]!
        .outstanding,
    ).toBe(2);
    expect(
      outstandingRewards({ lines: [item('l_buy', 'p_a', 1000, 2)], promotions: promo })[0]!
        .outstanding,
    ).toBe(1);
    expect(outstandingRewards({ lines: [item('l_buy', 'p_a', 1000, 1)], promotions: promo })).toEqual(
      [],
    );
  });

  it('is generic — a different product pair reads identically', () => {
    // The acceptance criterion. Same shape, different ids, no code path knows
    // which is which.
    const lines = [item('l_buy', 'p_paint', 4000, 3)];
    const three = offer('p_paint', 'p_brush', 3, 2);

    expect(outstandingRewards({ lines, promotions: [three] })[0]).toMatchObject({
      productId: 'p_brush',
      outstanding: 2,
    });
  });

  it('tracks two outstanding offers at once', () => {
    const lines = [item('l_a', 'p_a', 1000, 2), item('l_c', 'p_c', 800, 2)];
    const second = rule({
      id: 'r_second',
      name: 'Second offer',
      type: 'BUY_X_GET_Y',
      buyQuantity: 2,
      getQuantity: 1,
      percentageOff: 100,
      items: [
        { productId: 'p_c', role: 'BUY', quantity: 1 },
        { productId: 'p_d', role: 'GET', quantity: 1 },
      ],
    });

    const owed = outstandingRewards({ lines, promotions: [offer('p_a', 'p_b'), second] });
    expect(owed.map((o) => o.productId).sort()).toEqual(['p_b', 'p_d']);
  });

  it('a manually discounted qualifying line owes nothing', () => {
    // Precedence (D102) still holds: a discounted line is invisible to
    // promotions, so it earns no reward and the cashier is not asked for one.
    const lines = [item('l_buy', 'p_a', 1000, 2, 50)];

    expect(outstandingRewards({ lines, promotions: [offer('p_a', 'p_b')] })).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Partial overlap — a stackable promotion keeps the lines nobody else claimed
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A stackable promotion must not be thrown away because ONE of its lines was
 * taken by another promotion.
 *
 * ## What was wrong
 *
 * The loop read `if (candidate.claims.some(c => claimedLines.has(c.lineId)))
 * continue;` — one shared line and the entire candidate was discarded. A 10%-off
 * over {Short Pants, Black Suit} therefore vanished COMPLETELY the moment a
 * bundle claimed Black Suit, taking with it the discount on Short Pants, which
 * no other promotion in the basket touched.
 *
 * Reported from the till as "the bundle offer replaces the 10% discount" — a
 * fair description of what it looked like, because the operator watched a
 * discount they had already been shown disappear when an unrelated promotion
 * became eligible.
 *
 * ## The rule, and what it deliberately does NOT change
 *
 * The overlapping candidate is re-evaluated against the lines still free, and
 * its own rule decides whether it still qualifies. That keeps the fix generic:
 * no promotion type is special-cased, and no product or percentage is named.
 *
 * Three things stay exactly as they were, each asserted below rather than
 * assumed:
 *   • basket-level exclusivity — a non-stackable promotion still takes the lot;
 *   • one promotion per line — `SaleItem.promotionId` is a single column;
 *   • atomicity — a bundle or BOGO whose required set is broken applies NOTHING,
 *     because half a bundle is not a smaller discount, it is a wrong one.
 *
 * ## What makes these assertions non-vacuous (D30)
 *
 * The divisible case and the atomic case are asserted against each other. "The
 * overlapping promotion keeps its free lines" alone would pass for an applier
 * that also applied half a bundle — the most expensive way to get this wrong,
 * since it would charge a bundle price for an incomplete bundle. Every
 * partial-application test therefore has an atomic counterpart proving the
 * opposite.
 *
 * MUTATION PROOF is recorded at the end of this block.
 */
describe('a stackable promotion that partially overlaps keeps its free lines', () => {
  const pct = (id: string, productIds: string[], percentageOff: number, stackable: boolean) =>
    rule({
      id,
      type: 'PERCENTAGE_DISCOUNT',
      percentageOff,
      stackable,
      items: productIds.map((productId) => ({ productId, role: 'BUY' as const, quantity: 1 })),
    });

  const bundleRule = (
    id: string,
    productIds: string[],
    fixedPrice: number,
    stackable: boolean,
  ) =>
    rule({
      id,
      type: 'BUNDLE_FIXED_PRICE',
      fixedPrice,
      stackable,
      items: productIds.map((productId) => ({ productId, role: 'BUNDLE' as const, quantity: 1 })),
    });

  it('keeps the discount on a line the winner never touched — the reported defect', () => {
    // The reported basket: 10% over {shortpants, suit}; a bundle over
    // {suit, shirt, jeans, tie}. They overlap on `suit` only.
    const lines = [
      item('l_sp', 'shortpants', 2100),
      item('l_suit', 'suit', 2000),
      item('l_shirt', 'shirt', 1000),
      item('l_jeans', 'jeans', 4500),
      item('l_tie', 'tie', 500),
    ];
    const promotions = [
      bundleRule('r_bundle', ['suit', 'shirt', 'jeans', 'tie'], 2500, true),
      pct('r_pct', ['shortpants', 'suit'], 10, true),
    ];

    const result = applyPromotions({ lines, promotions });

    // POSITIVE: Short Pants keeps its 10%. This is the line that used to be
    // silently lost, and it is worth 210 to the customer.
    expect(byLine(result)).toEqual({
      l_sp: 210,
      l_suit: 1375,
      l_shirt: 687.5,
      l_jeans: 3093.75,
      l_tie: 343.75,
    });

    // NEGATIVE: the contested line went to the bundle and to the bundle ONLY.
    // One promotion per line is a schema fact, not a preference.
    const suitClaims = result.lines.filter((l) => l.lineId === 'l_suit');
    expect(suitClaims).toHaveLength(1);
    expect(suitClaims[0]!.promotionId).toBe('r_bundle');

    // Both promotions are visible on the bill, which is what was actually asked
    // for.
    expect(new Set(result.lines.map((l) => l.promotionId))).toEqual(
      new Set(['r_bundle', 'r_pct']),
    );
    expect(result.totalDiscount).toBe(5710);
  });

  it('applies NOTHING when an atomic promotion loses a required product', () => {
    /*
     * The counterpart that stops the fix going too far. The bundle needs both;
     * the percentage claims `tie` first, so the bundle can no longer be
     * completed. It must apply nothing at all — charging a bundle price for one
     * of two items would be the most expensive possible bug here.
     */
    const lines = [item('l_suit', 'suit', 100), item('l_tie', 'tie', 9000)];
    const promotions = [
      // Wins on size and claims `tie`: 90% of 9000 = 8100, against the bundle's
      // 9100 - 5000 = 4100. Stackable, so the bundle still gets its second
      // chance — which is the branch under test.
      pct('r_pct', ['tie'], 90, true),
      bundleRule('r_bundle', ['suit', 'tie'], 5000, true),
    ];

    const result = applyPromotions({ lines, promotions });

    // POSITIVE: the percentage applied.
    expect(byLine(result)).toEqual({ l_tie: 8100 });
    // NEGATIVE: the bundle applied nothing — not a reduced discount on the one
    // line it could still reach.
    expect(result.lines.map((l) => l.promotionId)).not.toContain('r_bundle');
  });

  it('DOCUMENTS a separate, pre-existing gap: a BOGO claims only its reward line', () => {
    /*
     * NOT a consequence of the partial-overlap change, and deliberately not
     * fixed here — pinned so the behaviour is a decision rather than a surprise.
     *
     * `applyBuyXGetY` returns claims on the REWARD lines only; the BUY units
     * that earned the reward are never claimed. So the overlap check cannot see
     * that those units are already paying for another promotion, and the reward
     * is granted anyway. Below, two shirts take 50% off AND earn a free tie.
     *
     * Whether that is generous or wrong is a pricing policy question, not a
     * mechanical one: the line-level invariant still holds (the shirt line
     * carries the percentage, the tie line carries the BOGO, neither carries
     * two), so nothing here is unpersistable. Changing it would make every BOGO
     * block discounts on its qualifying products, which is a real behavioural
     * change and needs a decision record — outside the scope of the reported
     * fix, whose brief was explicitly not to alter unrelated promotion
     * behaviour.
     *
     * Verified pre-existing: `claims` is `[l_tie]` either way, so the overlap
     * branch is never entered on this path and the old and new code agree.
     */
    const lines = [item('l_shirt', 'shirt', 1000, 2), item('l_tie', 'tie', 500)];
    const promotions = [
      pct('r_pct', ['shirt'], 50, true),
      rule({
        id: 'r_bogo',
        type: 'BUY_X_GET_Y',
        percentageOff: 100,
        buyQuantity: 2,
        getQuantity: 1,
        stackable: true,
        items: [
          { productId: 'shirt', role: 'BUY', quantity: 2 },
          { productId: 'tie', role: 'GET', quantity: 1 },
        ],
      }),
    ];

    const result = applyPromotions({ lines, promotions });

    // Current behaviour, stated exactly: the shirts are discounted 50% and the
    // tie is still free.
    expect(byLine(result)).toEqual({ l_shirt: 1000, l_tie: 500 });
    // The line-level invariant is intact — this is why it is a policy question
    // and not a correctness bug.
    expect(result.lines.filter((l) => l.lineId === 'l_shirt')).toHaveLength(1);
    expect(result.lines.filter((l) => l.lineId === 'l_tie')).toHaveLength(1);
  });

  it('leaves basket-level exclusivity exactly as it was', () => {
    /*
     * The re-evaluation branch must be unreachable for a NON-stackable
     * candidate: it either `continue`s (something already applied) or is first,
     * in which case nothing is claimed and there is no overlap. Asserted rather
     * than left to the comment that says so.
     */
    const lines = [item('l_sp', 'shortpants', 2100), item('l_suit', 'suit', 2000)];
    const promotions = [
      bundleRule('r_bundle', ['suit'], 500, false), // 1500, non-stackable, wins
      pct('r_pct', ['shortpants', 'suit'], 10, true),
    ];

    const result = applyPromotions({ lines, promotions });

    // The non-stackable winner takes the basket. Short Pants gets nothing even
    // though it is free and its own promotion is stackable — unchanged, and the
    // reason a basket of non-stackable promotions behaves as it does today.
    expect(byLine(result)).toEqual({ l_suit: 1500 });
    expect(result.lines.map((l) => l.promotionId)).not.toContain('r_pct');
  });

  it('re-offers only the free lines, never a line already claimed', () => {
    const lines = [item('l_a', 'a', 1000), item('l_b', 'b', 1000), item('l_c', 'c', 1000)];
    const promotions = [
      pct('r_1', ['a', 'b', 'c'], 50, true), // 1500 — takes everything
      pct('r_2', ['b', 'c'], 30, true), // 600 — both already taken
      pct('r_3', ['c'], 10, true), // 100 — already taken
    ];

    const result = applyPromotions({ lines, promotions });

    // The first promotion took all three lines, so the other two have nothing
    // left to re-evaluate against and must not double-discount any line.
    expect(byLine(result)).toEqual({ l_a: 500, l_b: 500, l_c: 500 });
    expect(result.lines).toHaveLength(3);
    expect(new Set(result.lines.map((l) => l.promotionId))).toEqual(new Set(['r_1']));
  });

  it('lets a third promotion take what the second could not', () => {
    const lines = [item('l_a', 'a', 1000), item('l_b', 'b', 1000), item('l_c', 'c', 1000)];
    const promotions = [
      pct('r_1', ['a'], 90, true), // 900 — largest, takes a
      pct('r_2', ['a', 'b'], 40, true), // 800 — overlaps on a, keeps b
      pct('r_3', ['c'], 10, true), // 100 — untouched
    ];

    const result = applyPromotions({ lines, promotions });

    // r_2 kept `b` at its own 40% rather than being discarded, and r_3 still ran.
    expect(byLine(result)).toEqual({ l_a: 900, l_b: 400, l_c: 100 });
    expect(new Set(result.lines.map((l) => l.promotionId))).toEqual(
      new Set(['r_1', 'r_2', 'r_3']),
    );
  });
});

/*
 * MUTATION PROOF (D30 section 5) for the block above. Every line is a run that
 * was executed, not a prediction — two of these disagreed with what was expected
 * before running them, and the record follows the runs.
 *
 * 1. The defect as it shipped — `continue` on any overlap:
 *      x keeps the discount on a line the winner never touched
 *      x lets a third promotion take what the second could not
 *    2 of 7. The five that pass are cases where discarding and re-evaluating
 *    give the same answer, which is exactly why the reported bug survived a
 *    52-test suite untouched.
 *
 * 2. Over-corrected — filter the ORIGINAL claims to the free lines instead of
 *    letting the rule re-qualify (the tempting one-line version):
 *      x applies NOTHING when an atomic promotion loses a required product
 *    1 of 7. NOTE: this was expected to fail 2, on the strength of the BOGO
 *    case as well. It does not, because that test now documents the pre-existing
 *    reward-line gap rather than asserting atomicity. One test therefore stands
 *    between this codebase and a bundle price charged for an incomplete bundle,
 *    which is worth knowing rather than assuming.
 *
 * 3. Basket exclusivity removed (`anyApplied && !stackable` guard deleted):
 *      x a stackable winner still shuts out a NON-stackable follower
 *    1 of 7 — and it is a PRE-EXISTING test that catches it, not the new
 *    'leaves basket-level exclusivity exactly as it was'. That new test uses a
 *    non-stackable winner applying first, so the deleted guard never runs in it.
 *    Both are kept: they cover the rule from opposite sides.
 */
