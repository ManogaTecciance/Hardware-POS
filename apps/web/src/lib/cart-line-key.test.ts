import { describe, expect, it } from 'vitest';

import { taxableBase, type PromotionRule } from '@hardware-pos/shared';

import {
  cartLineKey,
  computeCartLines,
  computeLine,
  computeTotals,
  lineLabel,
  linePrice,
  forgonePromotions,
  newCartItem,
  type CartItem,
} from './cart';
import type { ClientProduct, ClientVariant } from './catalog';
import { stockCap } from './pos-cart';

/**
 * D99 (1c.2) — the cart is keyed by (product, variant), not by product.
 *
 * Before this, every cart operation matched on `it.product.id`, so a Medium and a
 * Large of one shirt collapsed into a single line: `addToCart` found the product
 * already present and incremented it. These pin the identity rule and the two
 * places that read stock and price off the chosen variant rather than the product.
 *
 * The store itself is a React context, so the reducers are exercised through the
 * pure pieces they are built from — the key, the factory, and the line maths.
 */

function product(over: Partial<ClientProduct> = {}): ClientProduct {
  return {
    id: 'prod_shirt',
    name: 'Cotton Shirt',
    sku: null,
    type: 'Inventory',
    categoryName: 'Apparel',
    subcategoryId: null,
    subcategoryName: null,
    unitPrice: null, // a variant product owns no price of its own
    quantityOnHand: 20,
    stockState: 'IN_STOCK',
    imageUrl: null,
    taxable: true,
    variants: [],
    ...over,
  };
}

function variant(over: Partial<ClientVariant> = {}): ClientVariant {
  return {
    id: 'var_m',
    sku: 'SHIRT-M',
    barcode: null,
    name: 'Black / Medium',
    unitPrice: 2500,
    isDefault: false,
    quantityOnHand: 3,
    stockState: 'IN_STOCK',
    ...over,
  };
}

describe('cartLineKey', () => {
  it('keys a variant-less line with an empty variant half', () => {
    // Both halves are always present so the format cannot be ambiguous. A cart
    // persisted before 1c.2 is migrated through this same function on hydration,
    // so old lines get the same shape rather than a bare product id.
    expect(cartLineKey('prod_rice', null)).toBe('prod_rice::');
  });

  it('distinguishes two variants of the same product', () => {
    const medium = cartLineKey('prod_shirt', 'var_m');
    const large = cartLineKey('prod_shirt', 'var_l');

    expect(medium).not.toBe(large);
    // Both still name their product, so a key can be read back if ever needed.
    expect(medium.startsWith('prod_shirt')).toBe(true);
  });

  it('is stable for the same pair', () => {
    expect(cartLineKey('p', 'v')).toBe(cartLineKey('p', 'v'));
  });

  it('does not collide a variant line with a product whose id contains the delimiter', () => {
    // Both halves are always present, so `("prod_shirt", "var_m")` gives
    // "prod_shirt::var_m" while `("prod_shirt::var_m", null)` gives
    // "prod_shirt::var_m::" — unambiguous whatever an id contains. Keying a
    // variant-less line on the bare product id collided here, which is what
    // this test caught.
    expect(cartLineKey('prod_shirt', 'var_m')).not.toBe(cartLineKey('prod_shirt::var_m', null));
  });
});

describe('newCartItem', () => {
  it('carries the variant and a matching key', () => {
    const v = variant();
    const item = newCartItem(product(), v);

    expect(item.variant).toBe(v);
    expect(item.lineKey).toBe(cartLineKey('prod_shirt', 'var_m'));
    expect(item.quantity).toBe(1);
  });

  it('defaults to no variant, so pre-picker callers keep working', () => {
    const item = newCartItem(product({ unitPrice: 999, variants: [] }));

    expect(item.variant).toBeNull();
    expect(item.lineKey).toBe(cartLineKey('prod_shirt', null));
  });
});

describe('two sizes of one product are two lines', () => {
  /** The merge rule `addToCart` applies, in isolation from the React store. */
  function addTo(items: CartItem[], p: ClientProduct, v: ClientVariant | null): CartItem[] {
    const key = cartLineKey(p.id, v?.id ?? null);
    const found = items.find((it) => it.lineKey === key);
    return found
      ? items.map((it) => (it.lineKey === key ? { ...it, quantity: it.quantity + 1 } : it))
      : [...items, newCartItem(p, v)];
  }

  it('appends rather than merging when the variant differs', () => {
    const p = product();
    const medium = variant({ id: 'var_m', sku: 'SHIRT-M' });
    const large = variant({ id: 'var_l', sku: 'SHIRT-L' });

    let items: CartItem[] = [];
    items = addTo(items, p, medium);
    items = addTo(items, p, large);

    expect(items).toHaveLength(2);
    expect(items.map((it) => it.variant?.sku)).toEqual(['SHIRT-M', 'SHIRT-L']);
  });

  it('still merges when the same variant is added twice', () => {
    const p = product();
    const medium = variant();

    let items: CartItem[] = [];
    items = addTo(items, p, medium);
    items = addTo(items, p, medium);

    expect(items).toHaveLength(1);
    expect(items[0]!.quantity).toBe(2);
  });

  it('removing one size leaves the other', () => {
    const p = product();
    const items = [newCartItem(p, variant({ id: 'var_m' })), newCartItem(p, variant({ id: 'var_l' }))];

    // The defect a product-keyed filter would cause: both lines share a product
    // id, so removing by product would empty the cart.
    const after = items.filter((it) => it.lineKey !== cartLineKey('prod_shirt', 'var_m'));

    expect(after).toHaveLength(1);
    expect(after[0]!.variant?.id).toBe('var_l');
  });
});

describe('linePrice', () => {
  it('charges the variant price when a variant is chosen', () => {
    const item = newCartItem(product({ unitPrice: null }), variant({ unitPrice: 2500 }));
    expect(linePrice(item)).toBe(2500);
  });

  it('charges the product price when there is no variant', () => {
    const item = newCartItem(product({ unitPrice: 1200 }));
    expect(linePrice(item)).toBe(1200);
  });

  it('falls back to 0 rather than to a plausible wrong number', () => {
    // A variant product with no variant chosen has no price. Zero is visibly
    // wrong and gets reported; a product-level number would look right and ship.
    const item = newCartItem(product({ unitPrice: null }));
    expect(linePrice(item)).toBe(0);
  });
});

describe('outOfStock is judged against the variant', () => {
  it('flags a line that exceeds the variant stock, even when the product has plenty', () => {
    // 20 on the product across all sizes, 3 Mediums. Four Mediums is short.
    const item: CartItem = {
      ...newCartItem(product({ quantityOnHand: 20 }), variant({ quantityOnHand: 3 })),
      quantity: 4,
    };

    expect(computeLine(item).outOfStock).toBe(true);
  });

  it('does not flag a line within the variant stock', () => {
    const item: CartItem = {
      ...newCartItem(product({ quantityOnHand: 20 }), variant({ quantityOnHand: 3 })),
      quantity: 3,
    };

    expect(computeLine(item).outOfStock).toBe(false);
  });

  it('never flags an untracked variant', () => {
    const item: CartItem = {
      ...newCartItem(
        product(),
        variant({ stockState: 'UNTRACKED', quantityOnHand: null }),
      ),
      quantity: 99,
    };

    expect(computeLine(item).outOfStock).toBe(false);
  });

  it('uses the product quantity when there is no variant', () => {
    const item: CartItem = { ...newCartItem(product({ quantityOnHand: 2 })), quantity: 3 };
    expect(computeLine(item).outOfStock).toBe(true);
  });
});

/**
 * D99 (1c.6) — the two defects that survived 1c.2 because nothing called the
 * variant-aware code with a variant.
 */
describe('a line is identified by its size, not just its product', () => {
  it('gives two sizes of one product distinct keys', () => {
    // The React list rendered `key={item.product.id}`, so these two were
    // duplicate siblings and React reconciled them by position — a note or a
    // discount could land on the wrong row. The key was always distinct; the
    // JSX simply was not using it.
    const m = newCartItem(product(), variant({ id: 'var_m' }));
    const l = newCartItem(product(), variant({ id: 'var_l' }));

    expect(m.lineKey).not.toBe(l.lineKey);
    // Positive half: each key is the one the factory is supposed to produce.
    expect(m.lineKey).toBe(cartLineKey('prod_shirt', 'var_m'));
    expect(l.lineKey).toBe(cartLineKey('prod_shirt', 'var_l'));
    // And neither collapses to the bare product id, which is what the list used.
    expect(m.lineKey).not.toBe('prod_shirt');
  });
});

describe('the quantity cap follows the chosen size', () => {
  it('caps at the variant, not the product total', () => {
    // `stockCap(product, variant = null)` has a default, so the call site
    // `stockCap(item.product)` compiled cleanly for four commits while capping
    // at the product's 20 — a cashier could add 20 Mediums when 3 existed.
    const p = product({ quantityOnHand: 20 });
    const small = variant({ id: 'var_s', quantityOnHand: 3 });

    expect(stockCap(p, small)).toBe(3);
    expect(stockCap(p, small)).not.toBe(20);
    // The omitted-argument form is what the bug looked like; it still answers
    // the product, which is correct for a variant-less product and wrong here.
    expect(stockCap(p)).toBe(20);
  });

  it('leaves an untracked variant uncapped rather than capping at zero', () => {
    const p = product({ quantityOnHand: 0 });
    const untracked = variant({ stockState: 'UNTRACKED', quantityOnHand: null });

    expect(stockCap(p, untracked)).toBeNull();
  });
});

/**
 * D99 (1c.8) — a line named in one piece, for assistive text.
 */
describe('lineLabel names the size', () => {
  it('includes the variant name', () => {
    const item = newCartItem(product(), variant({ name: 'Black / Medium' }));

    expect(lineLabel(item)).toBe('Cotton Shirt, Black / Medium');
  });

  it('distinguishes two sizes of one product', () => {
    // The defect: the payment screen announced "Increase Cotton Shirt quantity"
    // for both buttons, so a screen-reader user could not tell which size they
    // were changing.
    const m = newCartItem(product(), variant({ id: 'var_m', name: 'Black / Medium' }));
    const l = newCartItem(product(), variant({ id: 'var_l', name: 'Black / Large' }));

    expect(lineLabel(m)).not.toBe(lineLabel(l));
  });

  it('is just the product name when there is no variant', () => {
    // Loose goods, a service, a single-SKU product — unchanged from before.
    expect(lineLabel(newCartItem(product({ unitPrice: 1500 }), null))).toBe('Cotton Shirt');
  });
});

/**
 * D101 (3.14) — the till previews exactly what the server will charge.
 *
 * 3.10 narrowed the taxable base on the SERVER and left `computeTotals` alone,
 * so a cashier was quoted 18% on an exempt item the server then charged nothing
 * for. That is the retail twin of audit item A2 — "its cashier quotes a total
 * the server disagrees with" — and it reached a person before a test.
 *
 * Both sides now call `taxableBase` from `@hardware-pos/shared`, so these
 * assertions reproduce the server's arithmetic exactly rather than approximating
 * it.
 */
describe('the till and the server agree on tax', () => {
  const taxed = (price: number) =>
    newCartItem(product({ id: 'p_taxed', unitPrice: price, taxable: true, variants: [] }), null);
  const exempt = (price: number) =>
    newCartItem(product({ id: 'p_exempt', unitPrice: price, taxable: false, variants: [] }), null);

  it('does not tax an exempt line — the reported defect', () => {
    // Short Pants: exempt, sold at 2,100. The till showed 378 tax; the server
    // charged 0.
    const totals = computeTotals([exempt(2100)], 18);

    expect(totals.taxAmount).toBe(0);
    expect(totals.total).toBe(2100);
  });

  it('taxes only the taxable line in a mixed basket', () => {
    // Cotton T-Shirt 1,850 taxed + Short Pants 2,100 exempt.
    const totals = computeTotals([taxed(1850), exempt(2100)], 18);

    expect(totals.subtotal).toBe(3950);
    expect(totals.taxAmount).toBe(333);
    expect(totals.total).toBe(4283);
  });

  it('matches the server, line for line, through the SHARED primitive', () => {
    // The invariant that broke. The server computes its base with the very same
    // function, so reproducing it here is the comparison — not an approximation
    // of it.
    const items = [taxed(1850), exempt(2100)];
    const tillTotals = computeTotals(items, 18);

    const serverBase = taxableBase(
      items.map((it) => ({ lineTotal: computeLine(it).lineTotal, taxable: it.product.taxable })),
      3950,
      0,
    );
    const serverTax = Math.round(((serverBase * 18) / 100) * 100) / 100;

    expect(tillTotals.taxAmount).toBe(serverTax);
  });

  it('an all-exempt basket is taxed nothing, never a credit', () => {
    const totals = computeTotals([exempt(1000), exempt(2100)], 18);

    expect(totals.taxAmount).toBe(0);
    expect(totals.taxAmount).not.toBeLessThan(0);
  });

  it('a fully taxable basket is UNCHANGED — the regression guard', () => {
    // Every tenant today. `taxable` defaults true, so the expression must reduce
    // to exactly what it was before 3.14.
    const totals = computeTotals([taxed(1000), taxed(500)], 18);

    expect(totals.subtotal).toBe(1500);
    expect(totals.taxAmount).toBe(270);
    expect(totals.total).toBe(1770);
  });

  it('removes the exempt line share of an order discount from the base too', () => {
    // Otherwise the exempt goods shrink the base twice. 10% of 3,950 is 395;
    // the taxed line's share is 185, leaving 1,665 taxable -> 18% = 299.70.
    const totals = computeTotals([taxed(1850), exempt(2100)], 18, {
      type: 'PERCENTAGE',
      value: 10,
    });

    expect(totals.orderDiscountAmount).toBe(395);
    expect(totals.taxAmount).toBe(299.7);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D102 (4.4) — promotions on the till
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The figures below are the SAME ones the server-side integration spec
 * (`promotion-sale.spec.ts`) asserts against a real sale. Both sides run
 * `applyPromotions` from `@hardware-pos/shared`, so pinning identical numbers in
 * both places is the till-server agreement — the guarantee 3.14 established for
 * tax, extended to promotions.
 */
describe('promotions on the till (4.4)', () => {
  const shirt = product({ id: 'p_shirt', name: 'Shirt', unitPrice: 1000, variants: [] });
  const tie = product({ id: 'p_tie', name: 'Tie', unitPrice: 500, variants: [] });

  const bogo = (over: Partial<PromotionRule> = {}): PromotionRule => ({
    id: 'promo_bogo',
    name: 'Buy 2 shirts, tie free',
    type: 'BUY_X_GET_Y',
    fixedPrice: null,
    percentageOff: null,
    amountOff: null,
    minimumSpend: null,
    buyQuantity: 2,
    getQuantity: 1,
    stackable: false,
    items: [
      { productId: 'p_shirt', role: 'BUY', quantity: 1 },
      { productId: 'p_tie', role: 'GET', quantity: 1 },
    ],
    ...over,
  });

  /** 2 shirts at 1,000 and a tie at 500. */
  const basket = (): CartItem[] => {
    const a = newCartItem(shirt, null);
    a.quantity = 2;
    return [a, newCartItem(tie, null)];
  };

  it('prices the promoted basket exactly as the server does', () => {
    const totals = computeTotals(basket(), 18, undefined, [bogo()]);

    expect(totals.subtotal).toBe(2500);
    // The tie is free: 500 off, and it is a LINE reduction, so it lands in
    // `totalDiscount` alongside any manual one.
    expect(totals.totalDiscount).toBe(500);
    // Tax follows automatically — 18% of 2,000, not of 2,500.
    expect(totals.taxAmount).toBe(360);
    expect(totals.total).toBe(2360);
  });

  it('the whole saving sits on the FREE line, not spread across the basket', () => {
    const lines = computeCartLines(basket(), [bogo()]);
    const byProduct = Object.fromEntries(
      lines.map((l, i) => [i === 0 ? 'shirt' : 'tie', l]),
    );

    // POSITIVE: the tie carries all 500 and nets to zero, so returning it
    // refunds nothing (D102).
    expect(byProduct.tie!.promotionDiscountAmount).toBe(500);
    expect(byProduct.tie!.lineTotal).toBe(0);
    expect(byProduct.tie!.promotionName).toBe('Buy 2 shirts, tie free');
    // NEGATIVE: the shirts are untouched. Spreading the saving by value would
    // give the tie only 100 and refund 400 on a free item.
    expect(byProduct.shirt!.promotionDiscountAmount).toBe(0);
    expect(byProduct.shirt!.lineTotal).toBe(2000);
  });

  it('INVARIANT — discountedSubtotal equals the sum of lineTotal', () => {
    /*
     * The load-bearing pair. `discountedSubtotal` is derived from
     * `totalDiscount`, and the tax base and the order discount are both derived
     * from IT. If a promotion reduced the lines without entering `totalDiscount`
     * — or the reverse — the two drift silently and the customer is charged tax
     * on money they never owed.
     */
    const items = basket();
    const rules = [bogo()];
    const totals = computeTotals(items, 18, undefined, rules);
    const lines = computeCartLines(items, rules);

    const sumLineTotals = Math.round(lines.reduce((a, l) => a + l.lineTotal, 0) * 100) / 100;
    const discountedSubtotal =
      Math.round((totals.subtotal - totals.totalDiscount) * 100) / 100;

    expect(discountedSubtotal).toBe(sumLineTotals);
    expect(discountedSubtotal).toBe(2000);
  });

  it('a promoted EXEMPT product is still untaxed', () => {
    const exemptTie = product({ id: 'p_tie', name: 'Tie', unitPrice: 500, taxable: false, variants: [] });
    const a = newCartItem(shirt, null);
    a.quantity = 2;
    const totals = computeTotals([a, newCartItem(exemptTie, null)], 18, undefined, [bogo()]);

    // The tie is both free AND exempt. Tax is 18% of the shirts alone either
    // way, which is the point: the two rules compose without knowing about
    // each other.
    expect(totals.taxAmount).toBe(360);
    expect(totals.total).toBe(2360);
  });

  it('a manual discount on one line and a promotion on another — each takes its own', () => {
    const items = basket();
    items[0]!.discount = { type: 'PERCENTAGE', value: 10 }; // 200 off the shirts

    const lines = computeCartLines(items, [bogo()]);

    // POSITIVE: the manual discount applied to the shirts…
    expect(lines[0]!.discountAmount).toBe(200);
    expect(lines[0]!.promotionDiscountAmount).toBe(0);
    /*
     * NEGATIVE: …and the BOGO did NOT fire, because the shirts are the BUY
     * side and a manually discounted line is invisible to promotions — it
     * cannot even satisfy a threshold (D102). The tie stays full price.
     */
    expect(lines[1]!.promotionDiscountAmount).toBe(0);
    expect(lines[1]!.lineTotal).toBe(500);
  });

  it('ZERO-CHANGE — a basket with no promotions prices exactly as before', () => {
    const items = basket();

    const withNone = computeTotals(items, 18, undefined, []);
    const withoutArg = computeTotals(items, 18);

    // The argument is optional and empty means "none", so every existing caller
    // and every pre-4.4 figure is untouched.
    expect(withNone).toEqual(withoutArg);
    expect(withNone.subtotal).toBe(2500);
    expect(withNone.totalDiscount).toBe(0);
    expect(withNone.taxAmount).toBe(450);
    expect(withNone.total).toBe(2950);
  });
});

/**
 * Open decision 3 (PO-confirmed 2026-09-04) — a manual discount that costs the
 * customer more than it saves.
 *
 * ## What was wrong
 *
 * D102 makes a manually discounted line invisible to promotions: the cashier is
 * acting deliberately, usually under an approval limit, and a promotion stacking
 * on top would push the total past a figure nobody approved. That is correct and
 * stays. What was missing is that nobody was told — knock Rs 50 off a line
 * carrying a Rs 500 promotion and the customer quietly pays Rs 450 MORE, with
 * the till showing a discount either way. This is 4.19's shape again: right
 * behaviour, invisible cause.
 *
 * ## What makes these assertions non-vacuous (D30)
 *
 * The warning is asserted to appear when it should AND to stay silent in the
 * three cases that look similar but are not: a manual discount that BEATS the
 * promotion (the cashier being generous), a discounted line that no promotion
 * would have touched, and a promotion the basket does not qualify for. A helper
 * that returned every discounted line would pass a "warns when it should" test
 * on its own and put a warning on nearly every discounted sale.
 *
 * The figures are asserted, not just the presence of a warning: the number the
 * cashier gave up is the whole point of showing it.
 *
 * MUTATION PROOF (D30 section 5), both runs executed:
 *
 *   1. Drop the `promotion > manual` comparison, warning on every discounted line:
 *        x stays silent when the manual discount BEATS the promotion
 *        x reports each affected line, and leaves the others alone
 *      2 of 6 fail. That comparison is the whole judgement, and both failures are
 *      the cases where a naive implementation nags a cashier who did nothing wrong.
 *
 *   2. Drop the `!hypothetical.promotionName` guard:
 *        (nothing fails)
 *      Recorded because it is true, not because it is comfortable. That guard is
 *      TYPE NARROWING, not a behavioural branch: a line with no promotion has
 *      `promotionDiscountAmount === 0`, and 0 can never exceed a manual discount
 *      that is greater than zero, so the comparison below already excludes it.
 *      No test is added for it, because there is no behaviour to assert.
 */
describe('forgonePromotions — a manual discount that displaced a bigger offer', () => {
  const shirtP = product({ id: 'p_shirt', name: 'Shirt', unitPrice: 1000, variants: [] });
  const capP = product({ id: 'p_cap', name: 'Cap', unitPrice: 800, variants: [] });

  const halfOffShirts = (over: Partial<PromotionRule> = {}): PromotionRule => ({
    id: 'promo_half',
    name: 'Half price shirts',
    type: 'PERCENTAGE_DISCOUNT',
    fixedPrice: null,
    percentageOff: 50,
    amountOff: null,
    minimumSpend: null,
    buyQuantity: null,
    getQuantity: null,
    stackable: true,
    items: [{ productId: 'p_shirt', role: 'BUY', quantity: 1 }],
    ...over,
  });

  const withDiscount = (p: ClientProduct, value: number) => ({
    ...newCartItem(p),
    discount: { type: 'FIXED' as const, value },
  });

  it('warns, and names what was given up', () => {
    // Rs 50 off a shirt that had Rs 500 waiting for it.
    const items = [withDiscount(shirtP, 50)];

    const [warning, ...rest] = forgonePromotions(items, [halfOffShirts()]);

    expect(rest).toHaveLength(0);
    expect(warning).toMatchObject({
      productName: 'Shirt',
      manualDiscountAmount: 50,
      promotionDiscountAmount: 500,
      promotionName: 'Half price shirts',
    });
  });

  it('stays silent when the manual discount BEATS the promotion', () => {
    // Rs 600 off against a Rs 500 offer — the cashier is being generous, and
    // warning here would be nagging them about a decision that helped.
    expect(forgonePromotions([withDiscount(shirtP, 600)], [halfOffShirts()])).toEqual([]);
  });

  it('stays silent for a discounted line no promotion covers', () => {
    // The Cap is discounted; the promotion is about Shirts. Nothing was lost.
    expect(forgonePromotions([withDiscount(capP, 100)], [halfOffShirts()])).toEqual([]);
  });

  it('stays silent when nothing is discounted, and when there are no promotions', () => {
    expect(forgonePromotions([newCartItem(shirtP)], [halfOffShirts()])).toEqual([]);
    expect(forgonePromotions([withDiscount(shirtP, 50)], [])).toEqual([]);
  });

  it('reports each affected line, and leaves the others alone', () => {
    const capOffer = halfOffShirts({
      id: 'promo_cap',
      name: 'Cap deal',
      percentageOff: 25,
      items: [{ productId: 'p_cap', role: 'BUY', quantity: 1 }],
    });
    // Shirt: 50 vs 500 -> warn. Cap: 300 vs 200 -> the cashier won, stay quiet.
    const items = [withDiscount(shirtP, 50), withDiscount(capP, 300)];

    const warnings = forgonePromotions(items, [halfOffShirts(), capOffer]);

    expect(warnings.map((w) => w.productName)).toEqual(['Shirt']);
  });

  it('does not warn about a promotion the basket cannot earn', () => {
    /*
     * A BOGO needing two shirts, with one in the cart. Removing the manual
     * discount would still earn nothing, so there is nothing to regret — this is
     * the case a naive "what would this line get" check gets wrong.
     */
    const tieP = product({ id: 'p_tie', name: 'Tie', unitPrice: 500, variants: [] });
    const bogoRule = halfOffShirts({
      id: 'promo_bogo2',
      name: 'Buy 2 shirts get a tie',
      type: 'BUY_X_GET_Y',
      percentageOff: 100,
      buyQuantity: 2,
      getQuantity: 1,
      items: [
        { productId: 'p_shirt', role: 'BUY', quantity: 2 },
        { productId: 'p_tie', role: 'GET', quantity: 1 },
      ],
    });

    expect(forgonePromotions([withDiscount(shirtP, 50), newCartItem(tieP)], [bogoRule])).toEqual(
      [],
    );
  });
});
