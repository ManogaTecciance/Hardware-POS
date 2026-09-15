/**
 * D198 — the buy-X-get-Y prompt resolver.
 *
 * The arithmetic is the shared applier's and is pinned there (D171); what is
 * pinned HERE is the two things this file adds — a table's sent rounds count,
 * and a decline silences exactly one ask — because each fails silently in
 * the direction of nagging or of never asking, and both look like a screen
 * that works.
 */
import type { PromotionCartLine, PromotionRule } from '@hardware-pos/shared';
import { describe, expect, it } from 'vitest';

import type { SessionDetail } from '@/lib/restaurant/types';

import { offerDeclineKey, pendingOffers, sentLinesForOffers } from './offer-prompts';

const TEA = 'prd_tea';
const SALAD = 'prd_salad';
const KOTTU = 'prd_kottu';

/** Buy 1 Plain Tea, get 1 Garden Salad free — the PO's own example. */
const TEA_SALAD: PromotionRule = {
  id: 'promo_tea',
  name: 'Free salad with tea',
  type: 'BUY_X_GET_Y',
  fixedPrice: null,
  percentageOff: 100,
  amountOff: null,
  buyQuantity: 1,
  getQuantity: 1,
  stackable: true,
  minimumSpend: null,
  items: [
    { productId: TEA, role: 'BUY', quantity: 1 },
    { productId: SALAD, role: 'GET', quantity: 1 },
  ],
};

/** Buy 2 Kottu get 1 free — the same-product shape. */
const KOTTU_B2G1: PromotionRule = {
  id: 'promo_kottu',
  name: 'Kottu Tuesday',
  type: 'BUY_X_GET_Y',
  fixedPrice: null,
  percentageOff: 100,
  amountOff: null,
  buyQuantity: 2,
  getQuantity: 1,
  stackable: true,
  minimumSpend: null,
  items: [
    { productId: KOTTU, role: 'BUY', quantity: 1 },
    { productId: KOTTU, role: 'GET', quantity: 1 },
  ],
};

function line(id: string, productId: string, quantity: number, unitPrice = 300): PromotionCartLine {
  return {
    id,
    productId,
    unitPrice,
    quantity,
    lineSubtotal: unitPrice * quantity,
    manualDiscountAmount: 0,
  };
}

const NONE = new Set<string>();

describe('pendingOffers', () => {
  it('asks for the salad the tea has earned, and stops once it is held', () => {
    const asked = pendingOffers({ lines: [line('a', TEA, 1)], promotions: [TEA_SALAD], declined: NONE });
    // POSITIVE — one ask, naming the reward and how many.
    expect(asked).toEqual([
      expect.objectContaining({ promotionId: 'promo_tea', productId: SALAD, needed: 1 }),
    ]);
    // NEGATIVE — with the salad in the basket there is nothing to ask.
    expect(
      pendingOffers({
        lines: [line('a', TEA, 1), line('b', SALAD, 1)],
        promotions: [TEA_SALAD],
        declined: NONE,
      }),
    ).toEqual([]);
  });

  it('asks nothing of a basket that has qualified for nothing', () => {
    // One kottu against buy-2-get-1: no threshold met, no question. Blocking
    // here would hold every small order in the shop (D171's own control).
    expect(
      pendingOffers({ lines: [line('a', KOTTU, 1)], promotions: [KOTTU_B2G1], declined: NONE }),
    ).toEqual([]);
    // Two kottu: the group is one short, and THAT is asked.
    expect(
      pendingOffers({ lines: [line('a', KOTTU, 2)], promotions: [KOTTU_B2G1], declined: NONE }),
    ).toEqual([expect.objectContaining({ productId: KOTTU, needed: 1 })]);
  });

  it('a decline silences that ask and no other', () => {
    const one = pendingOffers({ lines: [line('a', TEA, 1)], promotions: [TEA_SALAD], declined: NONE });
    const declined = new Set([one[0]!.declineKey]);

    // POSITIVE — the same ask, declined, is gone…
    expect(
      pendingOffers({ lines: [line('a', TEA, 1)], promotions: [TEA_SALAD], declined }),
    ).toEqual([]);
    // …NEGATIVE — a second tea earns a second salad, which is a NEW question.
    expect(
      pendingOffers({ lines: [line('a', TEA, 2)], promotions: [TEA_SALAD], declined }),
    ).toEqual([expect.objectContaining({ productId: SALAD, needed: 2 })]);
  });

  it('keys a decline on the promotion AND the ask', () => {
    expect(offerDeclineKey({ promotionId: 'promo_tea', needed: 1 })).toBe('promo_tea:1');
    expect(offerDeclineKey({ promotionId: 'promo_tea', needed: 2 })).not.toBe(
      offerDeclineKey({ promotionId: 'promo_tea', needed: 1 }),
    );
  });

  it('is silent with no rules or no lines, whatever was declined', () => {
    expect(pendingOffers({ lines: [line('a', TEA, 1)], promotions: [], declined: NONE })).toEqual([]);
    expect(pendingOffers({ lines: [], promotions: [TEA_SALAD], declined: NONE })).toEqual([]);
  });
});

describe('sentLinesForOffers', () => {
  const detail = {
    session: { id: 'ses_1' },
    orders: [
      {
        order: { id: 'ord_1' },
        rounds: [
          {
            round: { id: 'rnd_1', roundNumber: 1, status: 'SUBMITTED' },
            items: [
              // Counted: a sent, live line with a product behind it.
              {
                id: 'itm_tea',
                productId: TEA,
                unitPrice: '150.00',
                modifierTotal: '25.00',
                quantity: '2.000',
                status: 'SENT',
              },
              // NOT counted: voided — the guest does not have it.
              {
                id: 'itm_void',
                productId: SALAD,
                unitPrice: '300.00',
                modifierTotal: '0.00',
                quantity: '1.000',
                status: 'VOIDED',
              },
              // NOT counted: a legacy menu line names no product.
              {
                id: 'itm_legacy',
                productId: null,
                unitPrice: '100.00',
                modifierTotal: '0.00',
                quantity: '1.000',
                status: 'SENT',
              },
            ],
          },
          {
            // NOT counted: the draft round is the cart being typed.
            round: { id: 'rnd_2', roundNumber: 2, status: 'DRAFT' },
            items: [
              {
                id: 'itm_draft',
                productId: SALAD,
                unitPrice: '300.00',
                modifierTotal: '0.00',
                quantity: '1.000',
                status: 'PENDING',
              },
            ],
          },
        ],
      },
    ],
  } as unknown as SessionDetail;

  it('counts sent, live, product-backed lines and nothing else', () => {
    expect(sentLinesForOffers(detail)).toEqual([
      {
        id: 'sent:itm_tea',
        productId: TEA,
        // Modifiers ride on the unit, as the bill charges them.
        unitPrice: 175,
        quantity: 2,
        lineSubtotal: 350,
        manualDiscountAmount: 0,
      },
    ]);
    expect(sentLinesForOffers(null)).toEqual([]);
  });

  it('so tea in round one earns its salad while round two is being typed', () => {
    // The whole point of the dine-in half: the draft is empty, the table has
    // two teas, and the question is still asked.
    expect(
      pendingOffers({ lines: sentLinesForOffers(detail), promotions: [TEA_SALAD], declined: NONE }),
    ).toEqual([expect.objectContaining({ productId: SALAD, needed: 2 })]);
    // And a salad in the draft round-in-progress settles one of them.
    expect(
      pendingOffers({
        lines: [...sentLinesForOffers(detail), line('d', SALAD, 1)],
        promotions: [TEA_SALAD],
        declined: NONE,
      }),
    ).toEqual([expect.objectContaining({ productId: SALAD, needed: 1 })]);
  });
});
