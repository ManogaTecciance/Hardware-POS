/**
 * The till's promotion wire mapper must not drop a field.
 *
 * ## The defect this exists for
 *
 * D105 added `minimumSpend` to `PromotionRule`, declared it OPTIONAL, and
 * `toPromotionRule` was not updated. Building the object without it type-checked
 * cleanly — a missing optional field is a valid value — so the till received
 * `undefined`, read it as "no threshold", and took Rs 1,000 off a Rs 500 basket
 * from a promotion configured to need Rs 10,000.
 *
 * This is the SAME failure as 4.15's dropped `productName`, in the same kind of
 * mapper, three commits later. The structural answer shipped with the fix:
 * `minimumSpend` is now REQUIRED on `PromotionRule`, so the compiler refuses a
 * mapper that forgets it. This spec is the belt to that braces — it fails on the
 * value being wrong, which the compiler cannot see.
 *
 * ## What makes these assertions non-vacuous (D30)
 *
 * The threshold is asserted POSITIVELY (a real value survives) and NEGATIVELY
 * (an absent one becomes `null`, never `undefined`). The negative is the one
 * that matters: `undefined` and `null` behave identically under `?? 0` in the
 * applier, so only an explicit `toBeNull()` distinguishes a mapper that carries
 * the field from one that merely happens not to crash.
 *
 * Every other field is asserted in the same pass, because the way this bug
 * arrives is "someone added a field and updated the type but not the mapper" —
 * so the test has to notice the NEXT one too, not just this one.
 */
import { describe, expect, it } from 'vitest';

import { toPromotionRule, type ApiPromotionRule } from './catalog';

const wire = (over: Partial<ApiPromotionRule> = {}): ApiPromotionRule => ({
  id: 'promo_1',
  name: 'Big Basket Discount',
  type: 'FIXED_AMOUNT_DISCOUNT',
  fixedPrice: null,
  percentageOff: null,
  amountOff: '1000.00',
  minimumSpend: '10000.00',
  buyQuantity: null,
  getQuantity: null,
  stackable: true,
  items: [],
  ...over,
});

describe('toPromotionRule carries the whole rule to the till', () => {
  it('keeps the cart threshold — the reported defect', () => {
    const rule = toPromotionRule(wire());

    // POSITIVE: the number the operator typed, as a number.
    expect(rule.minimumSpend).toBe(10000);
    expect(rule.amountOff).toBe(1000);
  });

  it('turns an absent threshold into null, never undefined', () => {
    // A server predating D105 omits the field. `undefined` would read as
    // "no threshold" — which is the RIGHT answer here, but only by accident;
    // the same `undefined` arriving for a rule that HAS a threshold is the bug.
    // Asserting null keeps the two cases distinguishable.
    const rule = toPromotionRule(wire({ minimumSpend: undefined }));
    expect(rule.minimumSpend).toBeNull();
    expect(rule.minimumSpend).not.toBeUndefined();
  });

  it('maps every field, so the next added one is noticed too', () => {
    const rule = toPromotionRule(
      wire({
        type: 'BUY_X_GET_Y',
        percentageOff: '100.00',
        buyQuantity: 2,
        getQuantity: 1,
        amountOff: null,
        minimumSpend: null,
        items: [
          { productId: 'p_shirt', role: 'BUY', quantity: 2 },
          { productId: 'p_tie', role: 'GET', quantity: 1 },
        ],
      }),
    );

    // An exact object: a field added to `PromotionRule` and forgotten in the
    // mapper fails here, which is precisely how this bug should have surfaced.
    expect(rule).toEqual({
      id: 'promo_1',
      name: 'Big Basket Discount',
      type: 'BUY_X_GET_Y',
      fixedPrice: null,
      percentageOff: 100,
      amountOff: null,
      minimumSpend: null,
      buyQuantity: 2,
      getQuantity: 1,
      stackable: true,
      items: [
        { productId: 'p_shirt', role: 'BUY', quantity: 2 },
        { productId: 'p_tie', role: 'GET', quantity: 1 },
      ],
    });
  });
});
