import { Prisma } from '@hardware-pos/database';
import { FOOD_SERVICE_CAPABILITIES } from '@hardware-pos/shared';

import { SellableService } from './sellable.service';
import type { PromotionsRepository } from '../promotions/promotions.repository';

/**
 * D101 — `stockState` in the ONE POS read model.
 *
 * The claim, in both directions: for untracked kinds the 86 switch is the
 * ONLY thing that can make an item unavailable (SOLD_OUT), and for tracked
 * kinds the count remains the only authority — a `soldOutAt` that somehow
 * reaches a STOCK_ITEM row changes nothing it reports.
 */

const TENANT = 'tnt_1';
const BRANCH = 'brn_a';

function row(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'prd_1',
    name: 'Chicken Kottu',
    description: null,
    imageUrl: null,
    unitPrice: new Prisma.Decimal(1200),
    prepMinutes: 10,
    dietaryTags: [],
    foodType: 'FOOD',
    sellableKind: 'COMPOSED_ITEM',
    soldOutAt: null,
    hasVariants: false,
    isActive: true,
    quantityOnHand: new Prisma.Decimal(0),
    reorderLevel: null,
    category: null,
    subcategory: null,
    variants: [],
    modifierGroups: [],
    stationLinks: [],
    promotionItems: [],
    ...overrides,
  };
}

function buildService(products: unknown[], inventoryMode: 'LOCAL' | 'DISABLED' = 'LOCAL') {
  const prisma = {
    product: {
      findMany: jest.fn(async () => products),
      count: jest.fn(async () => products.length),
    },
    $queryRaw: jest.fn(async () => []),
  };
  const promotions = {
    listForCatalogue: jest.fn(async () => []),
  } as unknown as PromotionsRepository;
  const profiles = {
    getEffectiveProfile: jest.fn(async () => ({
      businessType: 'RESTAURANT',
      inventoryMode,
      capabilities: FOOD_SERVICE_CAPABILITIES,
    })),
  };
  return new SellableService(prisma as never, promotions, profiles as never);
}

describe('SellableService stockState (D101)', () => {
  it('an 86\'d dish reports SOLD_OUT with no quantity claim', async () => {
    const service = buildService([row({ soldOutAt: new Date('2026-09-03T10:00:00Z') })]);

    const res = await service.list(TENANT, { branchId: BRANCH });

    expect(res.items[0]!.stockState).toBe('SOLD_OUT');
    expect(res.items[0]!.availableQuantity).toBeNull();
  });

  it('the same dish without the switch reports UNTRACKED — its zero count claims nothing', async () => {
    const service = buildService([row()]);

    const res = await service.list(TENANT, { branchId: BRANCH });

    expect(res.items[0]!.stockState).toBe('UNTRACKED');
  });

  it('a SERVICE takes the switch exactly like a dish', async () => {
    const service = buildService([
      row({ sellableKind: 'SERVICE', soldOutAt: new Date('2026-09-03T10:00:00Z') }),
    ]);

    const res = await service.list(TENANT, { branchId: BRANCH });

    expect(res.items[0]!.stockState).toBe('SOLD_OUT');
  });

  it('a tracked item answers to its count, never to the switch', async () => {
    const service = buildService([
      row({
        sellableKind: 'STOCK_ITEM',
        soldOutAt: new Date('2026-09-03T10:00:00Z'),
        quantityOnHand: new Prisma.Decimal(24),
      }),
    ]);

    const res = await service.list(TENANT, { branchId: BRANCH });

    // 24 on hand IS the availability — the stray flag must not grey it.
    expect(res.items[0]!.stockState).toBe('IN_STOCK');
    expect(res.items[0]!.availableQuantity).toBe('24.000');
  });

  it('a tracked item at zero is OUT — the count side is untouched by D101', async () => {
    const service = buildService([row({ sellableKind: 'STOCK_ITEM' })]);

    const res = await service.list(TENANT, { branchId: BRANCH });

    expect(res.items[0]!.stockState).toBe('OUT');
  });

  it('DISABLED inventory ships no stock block at all, 86\'d or not', async () => {
    const service = buildService(
      [row({ soldOutAt: new Date('2026-09-03T10:00:00Z') })],
      'DISABLED',
    );

    const res = await service.list(TENANT, { branchId: BRANCH });

    expect(res.items[0]!.stockState).toBeUndefined();
    expect(res.items[0]!.availableQuantity).toBeUndefined();
  });
});
