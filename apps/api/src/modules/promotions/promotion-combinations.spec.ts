/**
 * D105 — all four promotion types in one basket, in every combination.
 *
 * ## What this exists for
 *
 * The reported defect was "one promotion removes another". 4.20 fixed the
 * mechanism; this spec is the standing proof that it stays fixed as the engine
 * grows, and it is written as an exhaustive matrix rather than a handful of
 * examples because the failure mode is a PARTICULAR PAIR interacting badly. A
 * suite of individually-tested promotions cannot see that.
 *
 * All 15 non-empty subsets of {Bundle, BOGO, Percentage, cart-level AmountOff}
 * are enumerated and asserted. The four-way case — the one that matters most to
 * the operator — is not a special test; it falls out of the same table, so it
 * cannot be quietly weakened while the others stay green.
 *
 * ## What makes these assertions non-vacuous (D30)
 *
 * Each combination is asserted against the SUM OF ITS PARTS, measured
 * individually in the same run. That is a much stronger claim than "some
 * discount happened": it fails if a promotion is dropped, if one is applied
 * twice, and if two are applied to the same line.
 *
 * The exact set of applied promotion ids is asserted too, not just the money, so
 * a combination that reached the right total by the wrong route still fails.
 *
 * Every promotion covers DISTINCT products, deliberately. Overlap is tested in
 * `applier.spec.ts`; mixing the two questions in one table would make a failure
 * ambiguous between "stacking broke" and "overlap resolution changed".
 *
 * The non-stackable rows are the counterweight: without them the whole matrix
 * would pass for an engine that ignored `stackable` and applied everything
 * always, which is exactly what the brief said not to build.
 */
import { applyPromotions, outstandingRewards, type PromotionCartLine, type PromotionRule } from '@hardware-pos/shared';

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures — generic. No product, percentage or amount here is special-cased in
// the engine; they are ordinary configuration values.
// ─────────────────────────────────────────────────────────────────────────────

const rule = (over: Partial<PromotionRule> & { id: string; type: PromotionRule['type'] }): PromotionRule => ({
  name: `Promo ${over.id}`,
  fixedPrice: null,
  percentageOff: null,
  amountOff: null,
  minimumSpend: null,
  buyQuantity: null,
  getQuantity: null,
  stackable: true,
  items: [],
  ...over,
});

const item = (id: string, productId: string, unitPrice: number, quantity = 1): PromotionCartLine => ({
  id,
  productId,
  unitPrice,
  quantity,
  lineSubtotal: Math.round(unitPrice * quantity * 100) / 100,
  manualDiscountAmount: 0,
});

const BUNDLE = (stackable = true) =>
  rule({
    id: 'bundle',
    type: 'BUNDLE_FIXED_PRICE',
    fixedPrice: 5000,
    stackable,
    items: [
      { productId: 'suit', role: 'BUNDLE', quantity: 1 },
      { productId: 'jeans', role: 'BUNDLE', quantity: 1 },
    ],
  });

const BOGO = (stackable = true) =>
  rule({
    id: 'bogo',
    type: 'BUY_X_GET_Y',
    percentageOff: 100,
    buyQuantity: 2,
    getQuantity: 1,
    stackable,
    items: [
      { productId: 'shirt', role: 'BUY', quantity: 2 },
      { productId: 'tie', role: 'GET', quantity: 1 },
    ],
  });

const PCT = (stackable = true) =>
  rule({
    id: 'pct',
    type: 'PERCENTAGE_DISCOUNT',
    percentageOff: 10,
    stackable,
    items: [{ productId: 'cap', role: 'BUY', quantity: 1 }],
  });

/** D105 — cart-level: NO items, and a threshold. */
const AMT = (stackable = true) =>
  rule({
    id: 'amt',
    type: 'FIXED_AMOUNT_DISCOUNT',
    amountOff: 1000,
    minimumSpend: 5000,
    stackable,
    items: [],
  });

/**
 * The basket every row of the matrix runs against.
 *
 * Chosen so the cart-level threshold is cleared in EVERY combination: the most
 * heavily discounted case (all three line promotions) still leaves 7,720
 * eligible against a 5,000 threshold. If it were marginal, a row failing would
 * be ambiguous between "the promotion was dropped" and "the threshold moved",
 * and the whole table would stop being evidence.
 */
const basket = (): PromotionCartLine[] => [
  item('l_suit', 'suit', 2300),
  item('l_jeans', 'jeans', 4500),
  item('l_shirt', 'shirt', 1000, 2),
  item('l_tie', 'tie', 500),
  item('l_cap', 'cap', 800),
];

const ALL = { bundle: BUNDLE, bogo: BOGO, pct: PCT, amt: AMT } as const;
type Key = keyof typeof ALL;
const KEYS: Key[] = ['bundle', 'bogo', 'pct', 'amt'];

/** Every non-empty subset, smallest first, so a failure reads in size order. */
const SUBSETS: Key[][] = Array.from({ length: 15 }, (_, i) =>
  KEYS.filter((_k, bit) => (i + 1) & (1 << bit)),
).sort((a, b) => a.length - b.length || a.join().localeCompare(b.join()));

function run(keys: Key[], stackable = true) {
  return applyPromotions({
    lines: basket(),
    promotions: keys.map((k) => ALL[k](stackable)),
  });
}

/** Line discount and order discount a promotion produces ON ITS OWN. */
const alone = new Map<Key, { line: number; order: number }>();
for (const k of KEYS) {
  const r = run([k]);
  alone.set(k, { line: r.totalDiscount, order: r.orderPromotion?.discountAmount ?? 0 });
}

describe('D105 — every combination of the four promotion types', () => {
  it('each type on its own discounts something, so the matrix is not measuring zeroes', () => {
    // A positive control for the whole file. Without it, a fixture mistake that
    // made every promotion inapplicable would let all 15 rows below pass by
    // asserting 0 === 0.
    expect(alone.get('bundle')).toEqual({ line: 1800, order: 0 });
    expect(alone.get('bogo')).toEqual({ line: 500, order: 0 });
    expect(alone.get('pct')).toEqual({ line: 80, order: 0 });
    // The cart-level one produces NO line discount and an order discount — the
    // distinction D105 exists for.
    expect(alone.get('amt')).toEqual({ line: 0, order: 1000 });
  });

  describe.each(SUBSETS.map((keys) => [keys.join(' + '), keys] as const))(
    '%s',
    (_label, keys) => {
      it('applies every promotion in the set, and the discounts add up', () => {
        const result = run(keys);

        const expectedLine =
          Math.round(keys.reduce((acc, k) => acc + alone.get(k)!.line, 0) * 100) / 100;
        const expectedOrder =
          Math.round(keys.reduce((acc, k) => acc + alone.get(k)!.order, 0) * 100) / 100;

        // Money: the combination is exactly the sum of its parts. Fails if a
        // promotion is dropped, double-applied, or applied to a line it did not
        // claim on its own.
        expect(result.totalDiscount).toBe(expectedLine);
        expect(result.orderPromotion?.discountAmount ?? 0).toBe(expectedOrder);

        // Identity: the exact set that applied, not a count. A right total
        // reached by the wrong promotions still fails here.
        const appliedLine = new Set(result.lines.map((l) => l.promotionId));
        const expectedLineIds = new Set(keys.filter((k) => alone.get(k)!.line > 0));
        expect(appliedLine).toEqual(expectedLineIds);

        expect(result.orderPromotion?.promotionId ?? null).toBe(
          keys.includes('amt') ? 'amt' : null,
        );

        // One promotion per line, always — the schema fact behind D102.
        const lineIds = result.lines.map((l) => l.lineId);
        expect(new Set(lineIds).size).toBe(lineIds.length);
      });
    },
  );

  it('THE FOUR-WAY CASE — all four coexist, stated in full', () => {
    /*
     * Called out separately from the table because it is the case the operator
     * asked for by name. Every figure is written literally rather than derived,
     * so this test says what the bill looks like and not merely that the
     * arithmetic is self-consistent.
     */
    const result = run(['bundle', 'bogo', 'pct', 'amt']);
    const byLine = Object.fromEntries(result.lines.map((l) => [l.lineId, l.discountAmount]));

    expect(byLine).toEqual({
      l_suit: 608.82, // bundle, allocated by gross share
      l_jeans: 1191.18, // bundle
      l_tie: 500, // BOGO reward, free
      l_cap: 80, // 10% off
    });
    // The BOGO's qualifying shirts are NOT discounted — the reward is.
    expect(byLine.l_shirt).toBeUndefined();

    expect(result.totalDiscount).toBe(2380);
    expect(result.orderPromotion).toEqual({
      promotionId: 'amt',
      promotionName: 'Promo amt',
      discountAmount: 1000,
    });

    // Subtotal 10,100 − 2,380 line − 1,000 cart = 6,720 before tax.
    const subtotal = basket().reduce((a, l) => a + l.lineSubtotal, 0);
    expect(subtotal - result.totalDiscount - result.orderPromotion!.discountAmount).toBe(6720);
  });
});

describe('D105 — stackable is still respected', () => {
  it('all NON-stackable: the best one takes the basket, cart-level included', () => {
    const result = run(['bundle', 'bogo', 'pct', 'amt'], false);

    // The bundle is the largest line candidate and locks the basket.
    expect(new Set(result.lines.map((l) => l.promotionId))).toEqual(new Set(['bundle']));
    expect(result.totalDiscount).toBe(1800);
    // NEGATIVE, and the point of this test: basket exclusivity reaches the
    // cart-level pass too. A cart-level promotion that ignored `basketLocked`
    // would be a silent hole in a PO-confirmed rule (4.4).
    expect(result.orderPromotion).toBeNull();
  });

  it('a non-stackable cart-level promotion will not join something already applied', () => {
    const result = applyPromotions({
      lines: basket(),
      promotions: [PCT(true), AMT(false)],
    });
    expect(result.totalDiscount).toBe(80);
    expect(result.orderPromotion).toBeNull();
  });

  it('a cart-level promotion applies alone even when non-stackable', () => {
    // POSITIVE counterpart to the row above: nothing else applied, so there is
    // nothing for exclusivity to exclude it from.
    const result = applyPromotions({ lines: basket(), promotions: [AMT(false)] });
    expect(result.orderPromotion?.discountAmount).toBe(1000);
  });

  it('mixed: a stackable line promotion and a stackable cart-level one coexist', () => {
    const result = applyPromotions({ lines: basket(), promotions: [PCT(true), AMT(true)] });
    expect(result.totalDiscount).toBe(80);
    expect(result.orderPromotion?.discountAmount).toBe(1000);
  });
});

describe('D105 — the cart-level threshold', () => {
  const cartOnly = (total: number) =>
    applyPromotions({
      lines: [item('l1', 'anything', total)],
      promotions: [rule({ id: 'amt', type: 'FIXED_AMOUNT_DISCOUNT', amountOff: 1000, minimumSpend: 10000, stackable: true, items: [] })],
    });

  it('meets the acceptance criteria exactly', () => {
    // The operator's own three cases, written as they were given.
    expect(cartOnly(9999).orderPromotion).toBeNull();
    expect(cartOnly(10000).orderPromotion?.discountAmount).toBe(1000);
    const r = cartOnly(12600);
    expect(r.orderPromotion?.discountAmount).toBe(1000);
    expect(12600 - r.orderPromotion!.discountAmount).toBe(11600);
  });

  it('is measured on the amount left AFTER line promotions', () => {
    /*
     * A basket whose gross clears the threshold but whose net does not. Reading
     * the gross would grant a discount against money already given away.
     */
    const lines = [item('l_a', 'a', 6000), item('l_b', 'b', 6000)];
    const half = rule({
      id: 'half',
      type: 'PERCENTAGE_DISCOUNT',
      percentageOff: 50,
      stackable: true,
      items: [{ productId: 'a', role: 'BUY', quantity: 1 }],
    });
    const amt = rule({ id: 'amt', type: 'FIXED_AMOUNT_DISCOUNT', amountOff: 500, minimumSpend: 10000, stackable: true, items: [] });

    // Gross 12,000 clears 10,000; net after the 50% is 9,000 and does not.
    expect(applyPromotions({ lines, promotions: [amt] }).orderPromotion?.discountAmount).toBe(500);
    expect(applyPromotions({ lines, promotions: [half, amt] }).orderPromotion).toBeNull();
  });

  it('never discounts more than the basket is worth', () => {
    const lines = [item('l1', 'x', 300)];
    const amt = rule({ id: 'amt', type: 'FIXED_AMOUNT_DISCOUNT', amountOff: 1000, stackable: true, items: [] });
    // Capped at the goods, so an order can never go negative.
    expect(applyPromotions({ lines, promotions: [amt] }).orderPromotion?.discountAmount).toBe(300);
  });

  it('recalculates from the current cart, leaving no stale state', () => {
    // The engine is a pure function of the basket, so "stale state" is not a
    // thing it can have — asserted rather than argued, by walking the operator's
    // own sequence across the threshold in both directions.
    const amt = rule({ id: 'amt', type: 'FIXED_AMOUNT_DISCOUNT', amountOff: 1000, minimumSpend: 10000, stackable: true, items: [] });
    const at = (total: number) =>
      applyPromotions({ lines: [item('l1', 'x', total)], promotions: [amt] }).orderPromotion
        ?.discountAmount ?? 0;

    expect(at(9500)).toBe(0); // below
    expect(at(10000)).toBe(1000); // crosses up
    expect(at(12600)).toBe(1000); // stays
    expect(at(9000)).toBe(0); // crosses back down — must disappear
  });
});

describe('D105 — payment is blocked only by a missing reward', () => {
  const owed = (lines: PromotionCartLine[], promotions: PromotionRule[]) =>
    outstandingRewards({ lines, promotions });

  it('a cart-level Amount Off never creates a reward requirement', () => {
    expect(owed(basket(), [AMT()])).toEqual([]);
    // …nor does adding it to a basket that already has other promotions.
    expect(owed(basket(), [BUNDLE(), PCT(), AMT()])).toEqual([]);
  });

  it('percentage and bundle never block either', () => {
    expect(owed(basket(), [PCT()])).toEqual([]);
    expect(owed(basket(), [BUNDLE()])).toEqual([]);
  });

  it('BOGO blocks until the reward is in the basket, and the others do not change that', () => {
    const withoutReward = [item('l_shirt', 'shirt', 1000, 2), item('l_cap', 'cap', 800)];

    // POSITIVE: blocked, and it names how many are owed.
    const blocked = owed(withoutReward, [BOGO(), PCT(), AMT()]);
    expect(blocked).toHaveLength(1);
    expect(blocked[0]!.outstanding).toBe(1);
    expect(blocked[0]!.promotionId).toBe('bogo');

    // NEGATIVE: the same basket with the reward added is not blocked, so the
    // block tracks the reward and not merely the presence of a BOGO.
    expect(owed([...withoutReward, item('l_tie', 'tie', 500)], [BOGO(), PCT(), AMT()])).toEqual(
      [],
    );
  });
});
