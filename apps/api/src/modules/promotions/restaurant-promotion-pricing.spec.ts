import { Prisma, RestaurantOrderChannel } from '@hardware-pos/database';

import {
  assertProjectionMatchesSubtotal,
  projectOrderItems,
  type ProjectedPromotion,
  type ProjectableOrderItem,
} from '../restaurant/settlement-projection';
import {
  computeRestaurantTotals,
  type RestaurantChargeConfig,
} from '../restaurant/restaurant-totals';
import { eligiblePromotionRules, priceLines } from './promotion-pricing';
import { RestaurantPromotionPricingService } from './restaurant-promotion-pricing.service';
import type { PromotionWithItems } from './promotions.repository';

/**
 * Promotions on a restaurant bill.
 *
 * D52 deferred this because "there is no promotion pricing engine anywhere".
 * D123 built one and retail has charged through it since; these specs pin the
 * wiring that finally lets a food-service tenant use what they configure.
 *
 * ## What makes these assertions non-vacuous (D30)
 *
 * Every case that asserts a discount lands also asserts what it does to the
 * figures AROUND it — the service charge, the tax, the total. A test that only
 * checked `promotionLineDiscount` would pass for an implementation that
 * computed the number and then billed the guest the undiscounted total, which
 * is precisely the bug being fixed: a promotion that exists and never reaches
 * the money.
 *
 * The channel cases are asserted in BOTH directions in the same suite. "A
 * dine-in promotion prices a dine-in bill" alone would pass for a build that
 * ignored channel scope entirely, and "a takeaway bill is untouched by it"
 * alone would pass for one that priced nothing at all.
 */

const d = (v: string | number) => new Prisma.Decimal(v);

function config(over: Partial<RestaurantChargeConfig> = {}): RestaurantChargeConfig {
  return {
    serviceChargePercent: d(0),
    serviceChargeChannels: ['DINE_IN'],
    serviceChargeTaxable: true,
    packagingChargeAmount: d(0),
    taxRatePercent: 0,
    ...over,
  };
}

/** A percentage promotion on one dish, live everywhere unless scoped. */
function promotion(over: Partial<PromotionWithItems> = {}): PromotionWithItems {
  return {
    id: 'promo_1',
    tenantId: 't1',
    name: 'Lunch 10%',
    description: null,
    type: 'PERCENTAGE_DISCOUNT',
    fixedPrice: null,
    percentageOff: d(10),
    amountOff: null,
    minimumSpend: null,
    buyQuantity: null,
    getQuantity: null,
    startsOn: null,
    endsOn: null,
    daysOfWeek: [],
    startTime: null,
    endTime: null,
    branchScope: [],
    channelScope: [],
    stackable: false,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    items: [{ id: 'pi_1', productId: 'prd_rice', role: 'BUY', quantity: 1, product: { name: 'Rice' } }],
    ...over,
  } as unknown as PromotionWithItems;
}

function orderItem(over: Partial<ProjectableOrderItem> = {}): ProjectableOrderItem {
  return {
    id: 'oi_1',
    menuItemName: 'Rice & Curry',
    unitPrice: d('1000.00'),
    modifierTotal: d(0),
    quantity: d(1),
    specialInstructions: null,
    productId: 'prd_rice',
    productVariantId: null,
    variantNameSnapshot: null,
    modifiers: [],
    ...over,
  };
}

describe('a promotion reaches the restaurant bill', () => {
  it('reduces the goods, and the service charge and tax follow', () => {
    const c = config({ serviceChargePercent: d(10), taxRatePercent: 10 });

    const before = computeRestaurantTotals(d('1000.00'), 'DINE_IN', c);
    const after = computeRestaurantTotals(d('1000.00'), 'DINE_IN', c, {
      lineDiscount: d('100.00'),
      orderDiscount: d(0),
    });

    // POSITIVE: the discount is recorded…
    expect(after.promotionLineDiscount.toFixed(2)).toBe('100.00');
    // …and it actually comes off what the guest pays. A bill that recorded the
    // discount and charged the undiscounted total is the defect being fixed.
    expect(before.total.toFixed(2)).toBe('1210.00');
    expect(after.total.toFixed(2)).toBe('1089.00');
    // The charges are computed on the discounted goods, not the gross ones:
    // 10% service on 900 = 90, and 10% tax on (900 + 90) = 99.
    expect(after.serviceChargeAmount.toFixed(2)).toBe('90.00');
    expect(after.taxAmount.toFixed(2)).toBe('99.00');
  });

  it('leaves every figure identical when nothing applies (the D52 behaviour)', () => {
    const c = config({ serviceChargePercent: d(10), taxRatePercent: 10 });
    const withArg = computeRestaurantTotals(d('1000.00'), 'DINE_IN', c, {
      lineDiscount: d(0),
      orderDiscount: d(0),
    });
    const without = computeRestaurantTotals(d('1000.00'), 'DINE_IN', c);

    // NEGATIVE: passing a zero promotion must not perturb the pipeline — this
    // is what lets the untouched D52 spec stand as the parity proof.
    expect(withArg.total.toFixed(2)).toBe(without.total.toFixed(2));
    expect(withArg.serviceChargeAmount.toFixed(2)).toBe(without.serviceChargeAmount.toFixed(2));
    expect(withArg.taxAmount.toFixed(2)).toBe(without.taxAmount.toFixed(2));
    expect(withArg.promotionLineDiscount.toFixed(2)).toBe('0.00');
  });

  it('takes a cart-level promotion AFTER tax, and never more than the bill', () => {
    const c = config({ taxRatePercent: 10 });

    const t = computeRestaurantTotals(d('1000.00'), 'DINE_IN', c, {
      lineDiscount: d(0),
      orderDiscount: d('200.00'),
    });
    // Tax is on the full 1,000 — the D126 asymmetry retail records as
    // PO-confirmed, copied rather than re-decided here.
    expect(t.taxAmount.toFixed(2)).toBe('100.00');
    expect(t.total.toFixed(2)).toBe('900.00');

    // A promotion larger than the bill floors it at zero. A negative total is a
    // balance the payment path would let a guest be refunded against.
    const huge = computeRestaurantTotals(d('1000.00'), 'DINE_IN', c, {
      lineDiscount: d(0),
      orderDiscount: d('5000.00'),
    });
    expect(huge.total.toFixed(2)).toBe('0.00');
    expect(huge.promotionOrderDiscount.toFixed(2)).toBe('1100.00');
  });
});

describe('the settled document carries what the bill charged', () => {
  it('nets the line and mirrors the discount beside it', () => {
    const awards = new Map<string, ProjectedPromotion>([
      [
        'oi_1',
        {
          promotionDiscountAmount: d('100.00'),
          promotionId: 'promo_1',
          promotionNameSnapshot: 'Lunch 10%',
        },
      ],
    ]);
    const [line] = projectOrderItems([orderItem()], awards);

    // `lineTotal` is what tax and the returns calculation read, so it must be
    // net; `promotionDiscountAmount` beside it is the D123 mirror.
    expect(line!.lineSubtotal.toFixed(2)).toBe('1000.00');
    expect(line!.lineTotal.toFixed(2)).toBe('900.00');
    expect(line!.promotionDiscountAmount.toFixed(2)).toBe('100.00');
    expect(line!.promotionNameSnapshot).toBe('Lunch 10%');
  });

  it('projects an unpromoted line exactly as it always did', () => {
    const [line] = projectOrderItems([orderItem()]);
    expect(line!.lineTotal.toFixed(2)).toBe('1000.00');
    expect(line!.promotionDiscountAmount.toFixed(2)).toBe('0.00');
    expect(line!.promotionId).toBeNull();
  });

  it('refuses to settle when the lines and the bill disagree about the discount', () => {
    const awards = new Map<string, ProjectedPromotion>([
      [
        'oi_1',
        {
          promotionDiscountAmount: d('100.00'),
          promotionId: 'promo_1',
          promotionNameSnapshot: 'Lunch 10%',
        },
      ],
    ]);
    const projected = projectOrderItems([orderItem()], awards);

    // The identity that must hold, and does.
    expect(() =>
      assertProjectionMatchesSubtotal(projected, d('1000.00'), d('100.00')),
    ).not.toThrow();
    // And the same call with a bill that took a DIFFERENT discount aborts —
    // without this the footer and the lines could tell a guest two stories.
    expect(() => assertProjectionMatchesSubtotal(projected, d('1000.00'), d('250.00'))).toThrow(
      /promotionDiscountAmount/,
    );
    // The subtotal half of the invariant still bites too.
    expect(() => assertProjectionMatchesSubtotal(projected, d('999.00'), d('100.00'))).toThrow(
      /lineSubtotal/,
    );
  });
});

describe('channel scope decides which bills a promotion touches', () => {
  const dineInOnly = promotion({ channelScope: ['DINE_IN'] } as Partial<PromotionWithItems>);
  const context = { now: new Date('2026-09-09T06:00:00Z'), branchId: 'brn_1' };

  it('prices the channel it is scoped to', () => {
    const rules = eligiblePromotionRules([dineInOnly], {
      ...context,
      channel: RestaurantOrderChannel.DINE_IN,
    });
    expect(rules).toHaveLength(1);

    const priced = priceLines(
      [
        {
          id: 'oi_1',
          productId: 'prd_rice',
          unitPrice: d('1000.00'),
          quantity: d(1),
          lineSubtotal: d('1000.00'),
        },
      ],
      rules,
    );
    expect(priced.totalLineDiscount.toFixed(2)).toBe('100.00');
    expect(priced.lines[0]!.promotionNameSnapshot).toBe('Lunch 10%');
  });

  it('does NOT price the channels it is not scoped to', () => {
    for (const channel of [RestaurantOrderChannel.TAKEAWAY, RestaurantOrderChannel.ONLINE]) {
      expect(eligiblePromotionRules([dineInOnly], { ...context, channel })).toHaveLength(0);
    }
  });

  it('leaves a line no promotion names untouched, and keeps the array aligned', () => {
    const rules = eligiblePromotionRules([promotion()], {
      ...context,
      channel: RestaurantOrderChannel.DINE_IN,
    });
    const priced = priceLines(
      [
        // A legacy MENU_ITEM round item: no Product behind it, so nothing can
        // name it. It must still come back, in position, at zero.
        {
          id: 'oi_legacy',
          productId: null,
          unitPrice: d('500.00'),
          quantity: d(1),
          lineSubtotal: d('500.00'),
        },
        {
          id: 'oi_1',
          productId: 'prd_rice',
          unitPrice: d('1000.00'),
          quantity: d(1),
          lineSubtotal: d('1000.00'),
        },
      ],
      rules,
    );
    expect(priced.lines.map((l) => l.id)).toEqual(['oi_legacy', 'oi_1']);
    expect(priced.lines[0]!.promotionDiscountAmount.toFixed(2)).toBe('0.00');
    expect(priced.lines[1]!.promotionDiscountAmount.toFixed(2)).toBe('100.00');
    expect(priced.totalLineDiscount.toFixed(2)).toBe('100.00');
  });

  it('is invisible to a line the cashier already discounted (D123)', () => {
    const rules = eligiblePromotionRules([promotion()], {
      ...context,
      channel: RestaurantOrderChannel.DINE_IN,
    });
    const priced = priceLines(
      [
        {
          id: 'oi_1',
          productId: 'prd_rice',
          unitPrice: d('1000.00'),
          quantity: d(1),
          lineSubtotal: d('1000.00'),
          manualDiscountAmount: d('50.00'),
        },
      ],
      rules,
    );
    expect(priced.totalLineDiscount.toFixed(2)).toBe('0.00');
  });
});

describe('RestaurantPromotionPricingService', () => {
  /** Minimal fakes: the service's only job is to read, then delegate. */
  function service(promotions: PromotionWithItems[], measured: string[] = []) {
    const prisma = {
      product: {
        findMany: jest.fn(async () =>
          measured.map((id) => ({ id, quantityType: 'DECIMAL' as const })),
        ),
      },
    };
    const repository = { listForCatalogue: jest.fn(async () => promotions) };
    // D139 — a fixed tenant zone, so a scheduled promotion in these specs
    // means the same thing on every machine that runs them.
    const settings = { getSettings: () => ({ timezone: 'Asia/Colombo' }) };
    return new RestaurantPromotionPricingService(
      prisma as never,
      repository as never,
      settings as never,
    );
  }

  const items = [
    {
      id: 'oi_1',
      productId: 'prd_rice',
      unitPrice: d('900.00'),
      modifierTotal: d('100.00'),
      quantity: d(1),
    },
  ];

  it('prices a dine-in order against a dine-in promotion', async () => {
    const priced = await service([
      promotion({ channelScope: ['DINE_IN'] } as Partial<PromotionWithItems>),
    ]).priceOrderItems('t1', 'brn_1', RestaurantOrderChannel.DINE_IN, items);

    // Modifiers are part of what the guest pays, so 10% is taken on 1,000.
    expect(priced.totalLineDiscount.toFixed(2)).toBe('100.00');
  });

  it('prices nothing when the promotion is scoped to another channel', async () => {
    const priced = await service([
      promotion({ channelScope: ['DINE_IN'] } as Partial<PromotionWithItems>),
    ]).priceOrderItems('t1', 'brn_1', RestaurantOrderChannel.TAKEAWAY, items);

    expect(priced.totalLineDiscount.toFixed(2)).toBe('0.00');
    expect(priced.lines[0]!.promotionId).toBeNull();
  });

  it('prices nothing when the promotion is scoped to another branch', async () => {
    const priced = await service([
      promotion({ branchScope: ['brn_other'] } as Partial<PromotionWithItems>),
    ]).priceOrderItems('t1', 'brn_1', RestaurantOrderChannel.DINE_IN, items);

    expect(priced.totalLineDiscount.toFixed(2)).toBe('0.00');
  });

  it('returns one entry per item even with no promotions at all', async () => {
    const priced = await service([]).priceOrderItems(
      't1',
      'brn_1',
      RestaurantOrderChannel.DINE_IN,
      items,
    );
    expect(priced.lines).toHaveLength(1);
    expect(priced.lines[0]!.id).toBe('oi_1');
    expect(priced.totalLineDiscount.toFixed(2)).toBe('0.00');
  });
});
