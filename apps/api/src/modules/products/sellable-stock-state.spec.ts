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
    // The QuickBooks item type every row carries; the default the API writes.
    type: 'Inventory',
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

function buildService(
  products: unknown[],
  inventoryMode: 'LOCAL' | 'DISABLED' = 'LOCAL',
  capabilities: typeof FOOD_SERVICE_CAPABILITIES = FOOD_SERVICE_CAPABILITIES,
) {
  const prisma = {
    product: {
      findMany: jest.fn(async () => products),
      count: jest.fn(async () => products.length),
    },
    // D120 — a variant's stock is its BranchInventory row; none here means
    // "0.000", which is the case the NonInventory assertion below exercises.
    branchInventory: { findMany: jest.fn(async () => []) },
    $queryRaw: jest.fn(async () => []),
  };
  const promotions = {
    listForCatalogue: jest.fn(async () => []),
  } as unknown as PromotionsRepository;
  const profiles = {
    getEffectiveProfile: jest.fn(async () => ({
      businessType: 'RESTAURANT',
      inventoryMode,
      capabilities,
    })),
  };
  // D139 — the evaluator reads the tenant's zone; pinned so these specs do
  // not depend on the clock of whatever machine runs them.
  const settings = { getSettings: () => ({ timezone: 'Asia/Colombo' }) };
  return new SellableService(prisma as never, promotions, profiles as never, settings as never);
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

/**
 * Main's rule (1ba3900), kept through the retail merge (D136): a QuickBooks
 * item whose type is not Inventory has no count. The form, the wizard and the
 * importer write 0 for it, nothing moves it, and the sale guard never reads
 * it — so the read model must not turn that placeholder into OUT. The kind
 * column cannot carry this: NonInventory derives to STOCK_ITEM, and the
 * migration that added the column left every legacy Service row there too.
 */
describe('SellableService stockState — the QuickBooks item type (main, D136)', () => {
  const nonInventoryAtZero = () =>
    row({ name: 'POL-1976', sellableKind: 'STOCK_ITEM', type: 'NonInventory', foodType: null });

  it('a NonInventory item at zero is UNTRACKED, not OUT, whatever its kind says', async () => {
    const res = await buildService([nonInventoryAtZero()]).list(TENANT, { branchId: BRANCH });

    expect(res.items[0]!.stockState).toBe('UNTRACKED');
    expect(res.items[0]!.availableQuantity).toBeNull();
    // The type travels, so the till can still label it "Non-Inventory".
    expect(res.items[0]!.type).toBe('NonInventory');
  });

  it('a legacy Service row the column default left as STOCK_ITEM is UNTRACKED too', async () => {
    const res = await buildService([
      row({ sellableKind: 'STOCK_ITEM', type: 'Service', foodType: null }),
    ]).list(TENANT, { branchId: BRANCH });

    expect(res.items[0]!.stockState).toBe('UNTRACKED');
  });

  it('NEGATIVE — the same row typed Inventory is OUT at zero: the count side is untouched', async () => {
    const res = await buildService([
      row({ sellableKind: 'STOCK_ITEM', type: 'Inventory', foodType: null }),
    ]).list(TENANT, { branchId: BRANCH });

    expect(res.items[0]!.stockState).toBe('OUT');
    expect(res.items[0]!.availableQuantity).toBe('0.000');
  });

  it('the sizes of a NonInventory product carry no count either', async () => {
    const variants = [
      {
        id: 'var_1',
        sku: 'POL-1976-M',
        barcode: null,
        unitPrice: new Prisma.Decimal(500),
        isDefault: true,
        isActive: true,
        optionValues: [],
      },
    ];
    const withVariants = {
      ...FOOD_SERVICE_CAPABILITIES,
      catalogue: { ...FOOD_SERVICE_CAPABILITIES.catalogue, variants: true },
    };
    const service = buildService(
      [
        nonInventoryAtZero(),
        row({ id: 'prd_2', sellableKind: 'STOCK_ITEM', type: 'Inventory', foodType: null }),
      ].map((r) => ({ ...r, hasVariants: true, variants })),
      'LOCAL',
      withVariants,
    );

    const res = await service.list(TENANT, { branchId: BRANCH });

    expect(res.items[0]!.variants![0]!.stockState).toBe('UNTRACKED');
    expect(res.items[0]!.variants![0]!.availableQuantity).toBeNull();
    // NEGATIVE — an Inventory product's size at zero is OUT, as before.
    expect(res.items[1]!.variants![0]!.stockState).toBe('OUT');
    expect(res.items[1]!.variants![0]!.availableQuantity).toBe('0.000');
  });
});
