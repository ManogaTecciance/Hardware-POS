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
    channelScope: [],
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

function buildService(prismaFake: any, auditFake: any) {
  const repo = fakeRepository(prismaFake);
  return new PromotionsService(prismaFake as any, repo, auditFake as any);
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
