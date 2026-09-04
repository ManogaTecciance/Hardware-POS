import { BadRequestException, NotFoundException } from '@nestjs/common';

import { PromotionsService } from './promotions.service';
import { PromotionsRepository, PromotionWithItems } from './promotions.repository';
import { CreatePromotionDto, PromotionTypeValue } from './dto/create-promotion.dto';

/**
 * Service tests use a hand-rolled Prisma stub rather than jest.mocked so
 * each spec is self-explanatory. Only the delegates the service touches are
 * implemented; anything else throws so an accidental new query surfaces
 * loudly. Each mutation test also checks the AuditLog is written — the D30
 * rule against vacuous asserts means we cannot rely on "the write path
 * ran" alone as evidence the operator sees an audit trail.
 */

interface Row {
  id: string;
  tenantId: string;
  isActive: boolean;
  name: string;
  type: string;
  fixedPrice: number | null;
  percentageOff: number | null;
  amountOff: number | null;
  buyQuantity: number | null;
  getQuantity: number | null;
  /** D56 — persisted by the double so a round-trip can be asserted. */
  channelScope: string[];
  items: { productId: string; role: string; quantity: number }[];
}

function fakePrisma(seed: { products: string[]; branches?: string[] } = { products: [] }) {
  const promos: Row[] = [];
  const branches = new Set(seed.branches ?? []);
  const products = new Set(seed.products);

  const api: any = {
    promos,
    branches,
    products,
    branch: {
      findMany: jest.fn(async ({ where }: any) => {
        const ids: string[] = where.id.in;
        return ids.filter((id) => branches.has(id)).map((id) => ({ id }));
      }),
    },
    product: {
      findMany: jest.fn(async ({ where }: any) => {
        const ids: string[] = where.id.in;
        return ids.filter((id) => products.has(id)).map((id) => ({ id }));
      }),
    },
    promotion: {
      create: jest.fn(async ({ data }: any) => {
        const row: Row = {
          id: `p_${promos.length + 1}`,
          tenantId: data.tenantId,
          isActive: true,
          name: data.name,
          type: data.type,
          fixedPrice: data.fixedPrice != null ? Number(data.fixedPrice) : null,
          percentageOff: data.percentageOff != null ? Number(data.percentageOff) : null,
          amountOff: data.amountOff != null ? Number(data.amountOff) : null,
          buyQuantity: data.buyQuantity ?? null,
          getQuantity: data.getQuantity ?? null,
          // D56 — the real column is persisted, so the double must persist it
          // too (D30: a fixture has to represent the production structure).
          // Without this, a round-trip assertion on channelScope would read the
          // hardcoded [] in `promotionRow` and pass for a service that dropped
          // the scope entirely.
          channelScope: data.channelScope ?? [],
          items: [],
        };
        promos.push(row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = promos.find((r) => r.id === where.id)!;
        Object.assign(row, data);
        return row;
      }),
      delete: jest.fn(async ({ where }: any) => {
        const idx = promos.findIndex((r) => r.id === where.id);
        return promos.splice(idx, 1)[0];
      }),
    },
    promotionItem: {
      createMany: jest.fn(async ({ data }: any) => {
        for (const d of data) {
          const p = promos.find((r) => r.id === d.promotionId)!;
          p.items.push({ productId: d.productId, role: d.role, quantity: d.quantity ?? 1 });
        }
        return { count: data.length };
      }),
      deleteMany: jest.fn(async ({ where }: any) => {
        const p = promos.find((r) => r.id === where.promotionId);
        if (p) p.items = [];
        return { count: 0 };
      }),
    },
    // The service passes an async callback; delegate execution back to the
    // same fake so the callback observes the mutations it makes.
    $transaction: jest.fn(async (arg: any) => {
      if (typeof arg === 'function') return arg(api);
      return Promise.all(arg);
    }),
  };
  return api;
}

function fakeRepository(prismaFake: any): PromotionsRepository {
  return {
    findById: jest.fn(async (_t: string, id: string): Promise<PromotionWithItems | null> => {
      const row = prismaFake.promos.find((r: Row) => r.id === id);
      if (!row) return null;
      return toRepoShape(row);
    }),
    list: jest.fn(async (tenantId: string): Promise<PromotionWithItems[]> =>
      prismaFake.promos.filter((r: Row) => r.tenantId === tenantId).map(toRepoShape),
    ),
    listForCatalogue: jest.fn(async (tenantId: string): Promise<PromotionWithItems[]> =>
      prismaFake.promos
        .filter((r: Row) => r.tenantId === tenantId && r.isActive)
        .map(toRepoShape),
    ),
  } as unknown as PromotionsRepository;
}

function toRepoShape(row: Row): PromotionWithItems {
  const decimalish = (n: number | null) =>
    n == null ? null : ({ toFixed: (p: number) => n.toFixed(p) } as any);
  return {
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    description: null,
    type: row.type,
    fixedPrice: decimalish(row.fixedPrice),
    percentageOff: decimalish(row.percentageOff),
    amountOff: decimalish(row.amountOff),
    buyQuantity: row.buyQuantity,
    getQuantity: row.getQuantity,
    startsOn: null,
    endsOn: null,
    daysOfWeek: [],
    startTime: null,
    endTime: null,
    branchScope: [],
    channelScope: row.channelScope ?? [],
    stackable: false,
    isActive: row.isActive,
    items: row.items.map((i, idx) => ({
      id: `pi_${idx}`,
      productId: i.productId,
      // 4.10 — the repository joins the product; the double must say so too
      // (D30: a fixture has to represent the production structure).
      product: { name: `Product ${i.productId}` },
      role: i.role,
      quantity: i.quantity,
    })),
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
  };
}

function fakeAudit() {
  return { record: jest.fn(async () => ({}) as any) };
}

/**
 * D56 — the channel vocabulary is the tenant's, not a constant. The double
 * returns whichever template the test is exercising so retail and food service
 * can be asserted against each other in one suite.
 */
function fakeProfiles(channels: string[] = ['COUNTER']) {
  return {
    getEffectiveProfile: jest.fn(async () => ({
      capabilities: { fulfilment: { channels } },
    })),
  };
}

function buildService(prismaFake: any, auditFake: any, profilesFake: any = fakeProfiles()) {
  const repo = fakeRepository(prismaFake);
  return new PromotionsService(prismaFake as any, repo, auditFake as any, profilesFake as any);
}

const TENANT = 'tnt_1';

function bundleDto(overrides: Partial<CreatePromotionDto> = {}): CreatePromotionDto {
  return {
    name: 'Combo Deal',
    type: 'BUNDLE_FIXED_PRICE' as PromotionTypeValue,
    fixedPrice: 25.0,
    items: [
      { productId: 'prd_1', role: 'BUNDLE' },
      { productId: 'prd_2', role: 'BUNDLE' },
    ],
    ...overrides,
  };
}

describe('PromotionsService — type-shape validation', () => {
  it('BUNDLE_FIXED_PRICE with only one BUNDLE item is rejected', async () => {
    const prisma = fakePrisma({ products: ['prd_1'] });
    const svc = buildService(prisma, fakeAudit());
    await expect(
      svc.create(
        TENANT,
        'usr_1',
        bundleDto({ items: [{ productId: 'prd_1', role: 'BUNDLE' }] }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    // NEGATIVE — no write happened, so the audit was never called.
    expect(prisma.promos).toHaveLength(0);
  });

  it('BUY_X_GET_Y with two BUY items is rejected', async () => {
    const prisma = fakePrisma({ products: ['prd_1', 'prd_2', 'prd_3'] });
    const svc = buildService(prisma, fakeAudit());
    await expect(
      svc.create(TENANT, 'usr_1', {
        name: 'Buy2 Get1',
        type: 'BUY_X_GET_Y',
        percentageOff: 100,
        buyQuantity: 1,
        getQuantity: 1,
        items: [
          { productId: 'prd_1', role: 'BUY' },
          { productId: 'prd_2', role: 'BUY' },
          { productId: 'prd_3', role: 'GET' },
        ],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('PERCENTAGE_DISCOUNT with percentageOff=0 is rejected', async () => {
    const prisma = fakePrisma({ products: ['prd_1'] });
    const svc = buildService(prisma, fakeAudit());
    await expect(
      svc.create(TENANT, 'usr_1', {
        name: 'Bad %',
        type: 'PERCENTAGE_DISCOUNT',
        percentageOff: 0,
        items: [{ productId: 'prd_1', role: 'BUY' }],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('PERCENTAGE_DISCOUNT with percentageOff=101 is rejected', async () => {
    const prisma = fakePrisma({ products: ['prd_1'] });
    const svc = buildService(prisma, fakeAudit());
    await expect(
      svc.create(TENANT, 'usr_1', {
        name: 'Bad %',
        type: 'PERCENTAGE_DISCOUNT',
        percentageOff: 101,
        items: [{ productId: 'prd_1', role: 'BUY' }],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('POSITIVE control — a valid BUNDLE_FIXED_PRICE creates the row', async () => {
    // Without this, every reject above would still pass on a broken create()
    // that always throws.
    const prisma = fakePrisma({ products: ['prd_1', 'prd_2'] });
    const audit = fakeAudit();
    const svc = buildService(prisma, audit);
    const view = await svc.create(TENANT, 'usr_1', bundleDto());
    expect(view.type).toBe('BUNDLE_FIXED_PRICE');
    expect(view.items).toHaveLength(2);
    expect(audit.record).toHaveBeenCalledWith(
      TENANT,
      expect.objectContaining({ action: 'PROMOTION_CREATED', userId: 'usr_1' }),
    );
  });
});

describe('PromotionsService — cross-tenant productId', () => {
  it('rejects a productId that does not belong to this tenant', async () => {
    // `prd_2` is not seeded, so the service's tenant-scope check refuses it
    // with a 404 rather than a 400.
    const prisma = fakePrisma({ products: ['prd_1'] });
    const svc = buildService(prisma, fakeAudit());
    await expect(svc.create(TENANT, 'usr_1', bundleDto())).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('PromotionsService — PATCH cannot change type', () => {
  it('rejects a body carrying a `type` field even though the DTO does not', async () => {
    const prisma = fakePrisma({ products: ['prd_1', 'prd_2'] });
    const svc = buildService(prisma, fakeAudit());
    const created = await svc.create(TENANT, 'usr_1', bundleDto());
    await expect(
      svc.update(TENANT, 'usr_1', created.id, {
        name: 'Renamed',
        ...({ type: 'PERCENTAGE_DISCOUNT' } as any),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('PromotionsService — audit trail on toggles', () => {
  it('records activate + deactivate + delete', async () => {
    const prisma = fakePrisma({ products: ['prd_1', 'prd_2'] });
    const audit = fakeAudit();
    const svc = buildService(prisma, audit);
    const created = await svc.create(TENANT, 'usr_1', bundleDto());

    await svc.setActive(TENANT, 'usr_1', created.id, false);
    await svc.setActive(TENANT, 'usr_1', created.id, true);
    await svc.delete(TENANT, 'usr_1', created.id);

    const actions = audit.record.mock.calls.map((c: any[]) => c[1].action);
    expect(actions).toEqual([
      'PROMOTION_CREATED',
      'PROMOTION_DEACTIVATED',
      'PROMOTION_ACTIVATED',
      'PROMOTION_DELETED',
    ]);
  });
});

/**
 * D56 — a promotion may only be scoped to a channel its tenant sells on.
 *
 * ## What was wrong
 *
 * `VALID_CHANNELS` was the constant `['DINE_IN','TAKEAWAY','ONLINE']`. Step 4.9
 * taught the editor to offer `capabilities.fulfilment.channels`, so a retail
 * shopkeeper was correctly shown a single **Counter** chip — and the server then
 * refused the only chip on screen with
 * `Unknown channel 'COUNTER'; expected one of DINE_IN, TAKEAWAY, ONLINE.`
 * A retail promotion with any channel scope was unsaveable, on every promotion
 * type. Half the fix shipped; this is the other half.
 *
 * ## What makes these assertions non-vacuous (D30)
 *
 * The two templates are asserted AGAINST EACH OTHER: retail accepts COUNTER and
 * rejects DINE_IN, food service does exactly the reverse. Either direction alone
 * would pass for a service that accepted every channel from everyone — which is
 * the obvious wrong fix (widening the constant to four values) and is what these
 * tests exist to rule out.
 *
 * The restaurant case is a regression guard, not a new requirement: its allowed
 * set is byte-identical to the deleted constant.
 *
 * MUTATION PROOF (D30 §5) — replacing the capability read with the obvious wrong
 * fix, a widened constant `['COUNTER','DINE_IN','TAKEAWAY','ONLINE']`:
 *
 *   ✗ RETAIL refuses a food-service channel
 *   ✗ FOOD SERVICE keeps its three, and is not handed COUNTER
 *   ✗ names the tenant's own channels in the error, not a fixed list
 *   ✗ PATCH is validated too, not just create
 *   ✓ RETAIL saves a COUNTER-scoped promotion            (agrees either way)
 *   ✓ an empty scope ... never consults the profile      (agrees either way)
 *
 * Four of six fail; the two that pass are the cases where a widened list and the
 * capability genuinely agree. Widening the constant would have made the reported
 * bug go away while quietly letting a restaurant scope a promotion to a retail
 * counter, so this is the mutation worth proving against.
 */
describe('PromotionsService — channels follow the tenant capability (D56)', () => {
  const RETAIL = ['COUNTER'];
  const FOOD = ['DINE_IN', 'TAKEAWAY', 'ONLINE'];

  it('RETAIL saves a COUNTER-scoped promotion', async () => {
    const prisma = fakePrisma({ products: ['prd_1', 'prd_2'] });
    const svc = buildService(prisma, fakeAudit(), fakeProfiles(RETAIL));

    const view = await svc.create(TENANT, 'usr_1', bundleDto({ channelScope: ['COUNTER'] }));

    // POSITIVE: it saved, and the scope round-tripped rather than being dropped.
    expect(view.channelScope).toEqual(['COUNTER']);
    expect(prisma.promos).toHaveLength(1);
  });

  it('RETAIL refuses a food-service channel', async () => {
    const prisma = fakePrisma({ products: ['prd_1', 'prd_2'] });
    const svc = buildService(prisma, fakeAudit(), fakeProfiles(RETAIL));

    await expect(
      svc.create(TENANT, 'usr_1', bundleDto({ channelScope: ['DINE_IN'] })),
    ).rejects.toBeInstanceOf(BadRequestException);
    // NEGATIVE: nothing was written on the way to the rejection.
    expect(prisma.promos).toHaveLength(0);
  });

  it('FOOD SERVICE keeps its three, and is not handed COUNTER', async () => {
    const prisma = fakePrisma({ products: ['prd_1', 'prd_2'] });
    const svc = buildService(prisma, fakeAudit(), fakeProfiles(FOOD));

    // POSITIVE — unchanged for the team that already had this working.
    const view = await svc.create(
      TENANT,
      'usr_1',
      bundleDto({ channelScope: ['DINE_IN', 'TAKEAWAY'] }),
    );
    expect(view.channelScope).toEqual(['DINE_IN', 'TAKEAWAY']);

    // NEGATIVE — a restaurant does not sell at a retail counter. This is the
    // assertion that fails if anyone "fixes" the bug by widening the constant
    // to all four channels instead of reading the capability.
    const prisma2 = fakePrisma({ products: ['prd_1', 'prd_2'] });
    const svc2 = buildService(prisma2, fakeAudit(), fakeProfiles(FOOD));
    await expect(
      svc2.create(TENANT, 'usr_1', bundleDto({ channelScope: ['COUNTER'] })),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma2.promos).toHaveLength(0);
  });

  it('names the tenant’s own channels in the error, not a fixed list', async () => {
    const prisma = fakePrisma({ products: ['prd_1', 'prd_2'] });
    const svc = buildService(prisma, fakeAudit(), fakeProfiles(RETAIL));

    // The old message told a retail operator to pick DINE_IN — advice that
    // would not have worked, since their editor offers no such chip.
    await expect(
      svc.create(TENANT, 'usr_1', bundleDto({ channelScope: ['DINE_IN'] })),
    ).rejects.toThrow('expected one of COUNTER');
  });

  it('an empty scope means every channel and never consults the profile', async () => {
    const prisma = fakePrisma({ products: ['prd_1', 'prd_2'] });
    const profiles = fakeProfiles(RETAIL);
    const svc = buildService(prisma, fakeAudit(), profiles);

    await svc.create(TENANT, 'usr_1', bundleDto({ channelScope: [] }));

    expect(prisma.promos).toHaveLength(1);
    // Runtime spy rather than source text (D30 §4): an unrestricted promotion
    // must not pay for a profile lookup it cannot act on.
    expect(profiles.getEffectiveProfile).not.toHaveBeenCalled();
  });

  it('PATCH is validated too, not just create', async () => {
    const prisma = fakePrisma({ products: ['prd_1', 'prd_2'] });
    const svc = buildService(prisma, fakeAudit(), fakeProfiles(RETAIL));
    const created = await svc.create(TENANT, 'usr_1', bundleDto({ channelScope: ['COUNTER'] }));

    // The editor saves an edit through PATCH, so a create-only check would have
    // left the same defect reachable one screen later.
    await expect(
      svc.update(TENANT, 'usr_1', created.id, { channelScope: ['ONLINE'] } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
