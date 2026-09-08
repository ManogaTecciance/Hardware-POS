import { BadRequestException } from '@nestjs/common';

import { ProductsService } from './products.service';
import type { ProductsRepository } from './products.repository';
import type { CatalogSyncProviderFactory } from '../providers/catalog/catalog-sync-provider.factory';
import type { PrismaService } from '../../prisma/prisma.service';
import type { StorageService } from '../../common/storage/storage.service';
import type { ProductAttributesService } from './product-attributes.service';

/**
 * D101 — the 86 switch and the trackStock refinement of the D65
 * classification rule.
 *
 * What is worth pinning:
 *
 * - `setAvailability` writes `soldOutAt` ONLY for kinds no other authority
 *   governs, refuses the rest with a named code, and repeats are no-ops that
 *   keep the ORIGINAL timestamp ("sold out since" must stay honest).
 * - `create` derives STOCK_ITEM for a food-typed row the operator counts
 *   (trackStock: true) and COMPOSED_ITEM otherwise — the exact rule every
 *   pre-D101 row already followed, so absent trackStock changes nothing.
 * - `update` re-derives only when a rule input is in the patch, and an
 *   absent trackStock answers from the STORED classification — changing a
 *   bottled water's foodType must not silently flip it back to a dish.
 *
 * Every dependency is a stub; assertions are about the writes the service
 * issues, not the database.
 */

const TENANT = 'tnt_1';

type AnyRecord = Record<string, unknown>;

function baseRow(overrides: AnyRecord = {}): AnyRecord {
  return {
    id: 'prod_1',
    tenantId: TENANT,
    name: 'Chicken Kottu',
    type: 'Inventory',
    sellableKind: 'COMPOSED_ITEM',
    foodType: 'FOOD',
    soldOutAt: null,
    isActive: true,
    quickbooksItemId: null,
    quantityOnHand: 0,
    categoryId: null,
    ...overrides,
  };
}

function makeService(existing: AnyRecord | null) {
  const update = jest.fn().mockImplementation((_id: string, data: AnyRecord) =>
    Promise.resolve({ ...(existing ?? {}), ...data }),
  );
  const create = jest.fn().mockImplementation((_tenantId: string, data: AnyRecord) =>
    Promise.resolve({ ...data, id: 'prod_new' }),
  );
  const repository = {
    findByIdForTenant: jest.fn().mockResolvedValue(existing),
    update,
    create,
    findSubcategory: jest.fn(),
  } as unknown as ProductsRepository;
  // Any disposition but QUEUED means "no external catalogue consequence",
  // which keeps applyCatalogSync out of the picture.
  const provider = {
    productCreated: jest.fn().mockResolvedValue({ disposition: 'SKIPPED' }),
    productUpdated: jest.fn().mockResolvedValue({ disposition: 'SKIPPED' }),
  };
  const catalogProviders = {
    forTenant: jest.fn().mockResolvedValue(provider),
  } as unknown as CatalogSyncProviderFactory;
  const attributes = {
    assertValidDocument: jest.fn().mockResolvedValue(undefined),
  } as unknown as ProductAttributesService;
  const service = new ProductsService(
    repository,
    catalogProviders,
    {} as StorageService,
    {} as PrismaService,
    attributes,
  );
  return { service, update, create };
}

describe('ProductsService.setAvailability (D101)', () => {
  it('86s an available dish — soldOutAt becomes a timestamp', async () => {
    const { service, update } = makeService(baseRow());

    await service.setAvailability(TENANT, 'prod_1', false);

    expect(update).toHaveBeenCalledWith('prod_1', { soldOutAt: expect.any(Date) });
  });

  it('brings a sold-out dish back — soldOutAt cleared to null', async () => {
    const { service, update } = makeService(
      baseRow({ soldOutAt: new Date('2026-09-03T10:00:00Z') }),
    );

    await service.setAvailability(TENANT, 'prod_1', true);

    expect(update).toHaveBeenCalledWith('prod_1', { soldOutAt: null });
  });

  it('a repeat 86 writes nothing, so the original timestamp survives', async () => {
    const since = new Date('2026-09-03T10:00:00Z');
    const { service, update } = makeService(baseRow({ soldOutAt: since }));

    const result = await service.setAvailability(TENANT, 'prod_1', false);

    expect(update).not.toHaveBeenCalled();
    expect((result as { soldOutAt: Date | null }).soldOutAt).toBe(since);
  });

  it.each([
    ['STOCK_ITEM', 'stock count'],
    ['BUNDLE', 'stock count'],
    ['TIME_SLOT', 'booking calendar'],
    ['STAY_UNIT', 'booking calendar'],
  ])('refuses a %s — its availability is governed by its %s', async (kind, authority) => {
    const { service, update } = makeService(baseRow({ sellableKind: kind, foodType: null }));

    await expect(service.setAvailability(TENANT, 'prod_1', false)).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'PRODUCT_AVAILABILITY_STOCK_GOVERNED',
        message: expect.stringContaining(authority),
      }),
    });
    expect(update).not.toHaveBeenCalled();
  });

  it('positive control: SERVICE takes the switch like a dish', async () => {
    const { service, update } = makeService(baseRow({ sellableKind: 'SERVICE' }));

    await service.setAvailability(TENANT, 'prod_1', false);

    expect(update).toHaveBeenCalledWith('prod_1', { soldOutAt: expect.any(Date) });
  });

  it('refuses to double as BadRequestException, not a silent success', async () => {
    const { service } = makeService(baseRow({ sellableKind: 'STOCK_ITEM' }));

    await expect(service.setAvailability(TENANT, 'prod_1', false)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

describe('deriveSellableKind via create (D65 + D101 trackStock)', () => {
  const dto = (over: AnyRecord) => ({ name: 'X', unitPrice: 100, ...over });

  it('a food-typed row the operator counts is a STOCK_ITEM (bottled water)', async () => {
    const { service, create } = makeService(null);

    await service.create(TENANT, dto({ foodType: 'BEVERAGE', trackStock: true }) as never);

    expect(create).toHaveBeenCalledWith(
      TENANT,
      expect.objectContaining({ sellableKind: 'STOCK_ITEM' }),
    );
  });

  it('a food-typed row without the answer stays a COMPOSED_ITEM — every pre-D101 payload derives what it always did', async () => {
    const { service, create } = makeService(null);

    await service.create(TENANT, dto({ foodType: 'FOOD' }) as never);

    expect(create).toHaveBeenCalledWith(
      TENANT,
      expect.objectContaining({ sellableKind: 'COMPOSED_ITEM' }),
    );
  });

  it('trackStock: false on a food-typed row is also a COMPOSED_ITEM (the wizard sends it explicitly)', async () => {
    const { service, create } = makeService(null);

    await service.create(TENANT, dto({ foodType: 'FOOD', trackStock: false }) as never);

    expect(create).toHaveBeenCalledWith(
      TENANT,
      expect.objectContaining({ sellableKind: 'COMPOSED_ITEM' }),
    );
  });

  it('type Service outranks everything — SERVICE even with trackStock: true', async () => {
    const { service, create } = makeService(null);

    await service.create(
      TENANT,
      dto({ type: 'Service', foodType: 'FOOD', trackStock: true }) as never,
    );

    expect(create).toHaveBeenCalledWith(
      TENANT,
      expect.objectContaining({ sellableKind: 'SERVICE' }),
    );
  });

  it('no foodType keeps the retail rule: plain STOCK_ITEM, trackStock ignored', async () => {
    const { service, create } = makeService(null);

    await service.create(TENANT, dto({ trackStock: false }) as never);

    expect(create).toHaveBeenCalledWith(
      TENANT,
      expect.objectContaining({ sellableKind: 'STOCK_ITEM' }),
    );
  });
});

describe('update re-derivation guard (D101)', () => {
  it('a patch touching no rule input leaves the classification alone', async () => {
    const { service, update } = makeService(baseRow({ sellableKind: 'STOCK_ITEM' }));

    await service.update(TENANT, 'prod_1', { name: 'Renamed' } as never, 'OWNER');

    expect(update).toHaveBeenCalledWith(
      'prod_1',
      expect.objectContaining({ sellableKind: undefined }),
    );
  });

  it('changing a tracked bottle\'s foodType WITHOUT trackStock keeps it tracked — the stored classification answers', async () => {
    const { service, update } = makeService(
      baseRow({ sellableKind: 'STOCK_ITEM', foodType: 'BEVERAGE', name: 'Water 500ml' }),
    );

    await service.update(TENANT, 'prod_1', { foodType: 'FOOD' } as never, 'OWNER');

    expect(update).toHaveBeenCalledWith(
      'prod_1',
      expect.objectContaining({ sellableKind: 'STOCK_ITEM' }),
    );
  });

  it('an explicit trackStock: false reclassifies the same row to COMPOSED_ITEM', async () => {
    const { service, update } = makeService(
      baseRow({ sellableKind: 'STOCK_ITEM', foodType: 'BEVERAGE', name: 'Water 500ml' }),
    );

    await service.update(TENANT, 'prod_1', { trackStock: false } as never, 'OWNER');

    expect(update).toHaveBeenCalledWith(
      'prod_1',
      expect.objectContaining({ sellableKind: 'COMPOSED_ITEM' }),
    );
  });
});
