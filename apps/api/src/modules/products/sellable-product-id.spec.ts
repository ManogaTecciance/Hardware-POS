import { Prisma } from '@hardware-pos/database';
import { FOOD_SERVICE_CAPABILITIES } from '@hardware-pos/shared';

import { SellableService } from './sellable.service';
import type { PromotionsRepository } from '../promotions/promotions.repository';

/**
 * D198 — `?productId=` on the ONE POS read model.
 *
 * The till fetches the reward product of a buy-X-get-Y offer by id, through
 * the same endpoint that shapes every other product it sells. The claims, in
 * both directions: the ids reach BOTH the page query and the count (a filter
 * that narrowed the rows but not `total` would page wrongly), and an absent
 * or empty list leaves the query exactly as it was.
 */

const TENANT = 'tnt_1';
const BRANCH = 'brn_a';

function row(id: string, name: string) {
  return {
    id,
    name,
    description: null,
    imageUrl: null,
    unitPrice: new Prisma.Decimal(450),
    prepMinutes: 5,
    dietaryTags: [],
    foodType: 'FOOD',
    sellableKind: 'COMPOSED_ITEM',
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
  };
}

function buildService(products: unknown[]) {
  // Typed with the argument they receive, so the assertions below can read
  // the `where` each call was given — an untyped `jest.fn(async () => …)`
  // infers no parameters and hides the calls from the compiler.
  const prisma = {
    product: {
      findMany: jest.fn(async (_args: PrismaArgs) => products),
      count: jest.fn(async (_args: PrismaArgs) => products.length),
    },
    branchInventory: { findMany: jest.fn(async () => []) },
    $queryRaw: jest.fn(async () => []),
  };
  const promotions = {
    listForCatalogue: jest.fn(async () => []),
  } as unknown as PromotionsRepository;
  const profiles = {
    getEffectiveProfile: jest.fn(async () => ({
      businessType: 'RESTAURANT',
      inventoryMode: 'LOCAL',
      capabilities: FOOD_SERVICE_CAPABILITIES,
    })),
  };
  const settings = { getSettings: () => ({ timezone: 'Asia/Colombo' }) };
  const service = new SellableService(
    prisma as never,
    promotions,
    profiles as never,
    settings as never,
  );
  return { service, prisma };
}

type PrismaArgs = { where: { AND: unknown[] } };

/** The AND-clauses a query was given. */
function andOf(args: PrismaArgs): unknown[] {
  return args.where.AND;
}

describe('SellableService productId filter (D198)', () => {
  it('narrows the page AND the count to the named ids', async () => {
    const { service, prisma } = buildService([row('prd_salad', 'Garden Salad')]);

    const res = await service.list(TENANT, { branchId: BRANCH, productId: ['prd_salad', 'prd_x'] });

    // POSITIVE — the clause reaches the row query…
    const pageAnd = andOf(prisma.product.findMany.mock.calls[0]![0]);
    expect(pageAnd).toContainEqual({ id: { in: ['prd_salad', 'prd_x'] } });
    // …AND the count, so `total` describes the same set the rows do.
    const countAnd = andOf(prisma.product.count.mock.calls[0]![0]);
    expect(countAnd).toContainEqual({ id: { in: ['prd_salad', 'prd_x'] } });
    expect(res.items.map((i) => i.id)).toEqual(['prd_salad']);
  });

  it('NEGATIVE — absent or empty leaves the query without an id clause', async () => {
    const { service, prisma } = buildService([row('prd_1', 'Kottu')]);

    await service.list(TENANT, { branchId: BRANCH });
    await service.list(TENANT, { branchId: BRANCH, productId: [] });

    for (const call of prisma.product.findMany.mock.calls) {
      const clauses = andOf(call[0]) as { id?: unknown }[];
      expect(clauses.some((c) => c.id !== undefined)).toBe(false);
    }
  });

  it('composes with the other filters rather than replacing them', async () => {
    const { service, prisma } = buildService([]);

    await service.list(TENANT, { branchId: BRANCH, productId: ['prd_1'], search: 'kottu' });

    const clauses = andOf(prisma.product.findMany.mock.calls[0]![0]) as Record<string, unknown>[];
    // The id clause is one clause AMONG the search's, not instead of it.
    expect(clauses.some((c) => c.id !== undefined)).toBe(true);
    expect(clauses.some((c) => c.OR !== undefined)).toBe(true);
  });
});
