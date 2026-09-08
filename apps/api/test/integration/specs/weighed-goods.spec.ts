/**
 * `6.1` — weighed goods, the data layer (D113, D113b, D113c).
 *
 * ## What can only be proven here
 *
 *  • That `quantityType` defaults to `WHOLE` for a product created by a client
 *    that has never heard of it — the property that makes the migration safe for
 *    every existing restaurant, hardware and retail tenant.
 *  • That D113c is checked against the **resulting** state. A payload-only check
 *    passes the only two cases worth guarding, and only a stored row can show
 *    the difference.
 *  • That a fractional quantity survives the round trip to `Decimal(12,3)`.
 *
 * ## What makes these assertions non-vacuous (D30)
 *
 * The two update cases are the ones a payload-only implementation gets wrong:
 * turning a product `DECIMAL` while its stored unit is null, and clearing the
 * unit on a product that is already `DECIMAL`. Both are asserted, and each is
 * paired with the partial update that must still be ALLOWED — otherwise the rule
 * would pass for an implementation that refused every update touching neither
 * field.
 */

import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import {
  AccountingProviderKind,
  BusinessType,
  InventoryMode,
  QuantityType,
  type PrismaClient,
} from '@hardware-pos/database';

import { validateEnv } from '../../../src/config/env.validation';
import { StorageModule } from '../../../src/common/storage/storage.module';
import { PrismaModule } from '../../../src/prisma/prisma.module';
import { PlatformModule } from '../../../src/modules/platform/platform.module';
import { ProvidersModule } from '../../../src/modules/providers/providers.module';
import { ProductsModule } from '../../../src/modules/products/products.module';
import { ProductsService } from '../../../src/modules/products/products.service';
import { SellableService } from '../../../src/modules/products/sellable.service';
import { SalesModule } from '../../../src/modules/sales/sales.module';

import { connectTestPrisma, disconnectTestPrisma } from '../prisma-test-client';
import { resetDatabase } from '../db-reset';
import { seedTileShopWithQuickBooks, type SeededTenant } from '../fixtures';

let prisma: PrismaClient;
let testModule: TestingModule;
let products: ProductsService;
let sellable: SellableService;
let shop: SeededTenant;

beforeAll(async () => {
  prisma = await connectTestPrisma();
  testModule = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
      StorageModule,
      PrismaModule,
      PlatformModule,
      ProvidersModule,
      SalesModule,
      ProductsModule,
    ],
  }).compile();
  testModule.useLogger(false);
  await testModule.init();
  products = testModule.get(ProductsService);
  sellable = testModule.get(SellableService);
});

afterAll(async () => {
  await testModule.close();
  await disconnectTestPrisma();
});

beforeEach(async () => {
  await resetDatabase(prisma);
  shop = await seedTileShopWithQuickBooks(prisma);
  await prisma.tenantBusinessProfile.create({
    data: {
      tenantId: shop.tenantId,
      businessType: BusinessType.RETAIL,
      inventoryMode: InventoryMode.LOCAL,
      accountingProvider: AccountingProviderKind.NONE,
    },
  });
});

/** The shape a client sends; cast because the DTO carries validation only. */
function productInput(extra: Record<string, unknown> = {}) {
  return { name: 'Test Product', type: 'Inventory', unitPrice: 100, ...extra } as never;
}

describe('the flag defaults to WHOLE', () => {
  it('a product created without mentioning it is WHOLE, with no unit', async () => {
    // The property that makes this migration safe: a client that has never
    // heard of measured goods keeps working, and every existing product reads
    // as it always did.
    const created = await products.create(shop.tenantId, productInput({ name: 'A Shirt' }));

    const row = await prisma.product.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.quantityType).toBe(QuantityType.WHOLE);
    expect(row.unitOfMeasure).toBeNull();
  });

  it('every product the fixture seeded is WHOLE', async () => {
    // Stated against the SEEDED rows, not one this spec created: those stand in
    // for the products already in every tenant's database when the migration
    // runs. `@default(WHOLE)` is what makes that true and this is where it shows.
    const all = await prisma.product.findMany({ where: { tenantId: shop.tenantId } });
    expect(all.length).toBeGreaterThan(0);
    expect(all.map((p) => p.quantityType)).toEqual(all.map(() => QuantityType.WHOLE));
  });
});

describe('D113c — the unit is required for a measured product', () => {
  it('refuses a DECIMAL product created with no unit', async () => {
    await expect(
      products.create(shop.tenantId, productInput({ quantityType: 'DECIMAL' })),
    ).rejects.toBeInstanceOf(BadRequestException);

    // Nothing was written on the way to the refusal.
    expect(await prisma.product.count({ where: { name: 'Test Product' } })).toBe(0);
  });

  it('creates a DECIMAL product that names its unit', async () => {
    const rice = await products.create(
      shop.tenantId,
      productInput({ name: 'Rice', quantityType: 'DECIMAL', unitOfMeasure: 'kg', unitPrice: 200 }),
    );

    const row = await prisma.product.findUniqueOrThrow({ where: { id: rice.id } });
    expect(row.quantityType).toBe(QuantityType.DECIMAL);
    expect(row.unitOfMeasure).toBe('kg');
  });

  it('refuses turning a WHOLE product DECIMAL when it has no stored unit', async () => {
    // The FIRST case a payload-only check gets wrong: the payload mentions only
    // `quantityType`, and there is no unit anywhere.
    const shirt = await products.create(shop.tenantId, productInput({ name: 'A Shirt' }));

    await expect(
      products.update(shop.tenantId, shirt.id, { quantityType: 'DECIMAL' } as never, 'OWNER' as never),
    ).rejects.toBeInstanceOf(BadRequestException);

    const row = await prisma.product.findUniqueOrThrow({ where: { id: shirt.id } });
    expect(row.quantityType).toBe(QuantityType.WHOLE);
  });

  it('allows the same switch when the unit comes with it', async () => {
    // The pair to the case above. Without this, the refusal would pass for an
    // implementation that refused every switch to DECIMAL.
    const shirt = await products.create(shop.tenantId, productInput({ name: 'Loose Nails' }));

    await products.update(
      shop.tenantId,
      shirt.id,
      { quantityType: 'DECIMAL', unitOfMeasure: 'kg' } as never,
      'OWNER' as never,
    );

    const row = await prisma.product.findUniqueOrThrow({ where: { id: shirt.id } });
    expect(row.quantityType).toBe(QuantityType.DECIMAL);
    expect(row.unitOfMeasure).toBe('kg');
  });

  it('refuses clearing the unit on a product that is already DECIMAL', async () => {
    // The SECOND case a payload-only check gets wrong: the payload mentions only
    // `unitOfMeasure`, and `quantityType` has to be read from the stored row.
    const rice = await products.create(
      shop.tenantId,
      productInput({ name: 'Rice', quantityType: 'DECIMAL', unitOfMeasure: 'kg' }),
    );

    await expect(
      products.update(shop.tenantId, rice.id, { unitOfMeasure: '' } as never, 'OWNER' as never),
    ).rejects.toBeInstanceOf(BadRequestException);

    const row = await prisma.product.findUniqueOrThrow({ where: { id: rice.id } });
    expect(row.unitOfMeasure).toBe('kg');
  });

  it('allows a partial update that mentions neither field', async () => {
    // The control for both refusals above: an ordinary edit must not be caught
    // by a rule about two fields it never touched.
    const rice = await products.create(
      shop.tenantId,
      productInput({ name: 'Rice', quantityType: 'DECIMAL', unitOfMeasure: 'kg' }),
    );

    await products.update(shop.tenantId, rice.id, { name: 'Samba Rice' } as never, 'OWNER' as never);

    const row = await prisma.product.findUniqueOrThrow({ where: { id: rice.id } });
    expect(row.name).toBe('Samba Rice');
    expect(row.quantityType).toBe(QuantityType.DECIMAL);
    expect(row.unitOfMeasure).toBe('kg');
  });

  it('allows switching back to WHOLE, keeping the unit (D113b §2)', async () => {
    // Switching is always allowed — a shop that flagged something wrongly on day
    // one must be able to correct it. The unit is left alone rather than
    // scrubbed: switching back again should not lose it.
    const rice = await products.create(
      shop.tenantId,
      productInput({ name: 'Rice', quantityType: 'DECIMAL', unitOfMeasure: 'kg' }),
    );

    await products.update(shop.tenantId, rice.id, { quantityType: 'WHOLE' } as never, 'OWNER' as never);

    const row = await prisma.product.findUniqueOrThrow({ where: { id: rice.id } });
    expect(row.quantityType).toBe(QuantityType.WHOLE);
    expect(row.unitOfMeasure).toBe('kg');
  });

  it('trims the unit rather than storing what was typed', async () => {
    const rice = await products.create(
      shop.tenantId,
      productInput({ name: 'Rice', quantityType: 'DECIMAL', unitOfMeasure: '  kg  ' }),
    );
    const row = await prisma.product.findUniqueOrThrow({ where: { id: rice.id } });
    expect(row.unitOfMeasure).toBe('kg');
  });
});

describe('a fractional quantity survives the database', () => {
  it('stores 0.750 exactly, at three decimal places', async () => {
    // `Decimal(12,3)` is the whole reason D113 needs no schema work beyond the
    // flag. Asserted rather than assumed: a column that silently truncated would
    // make every weighed sale wrong by up to a gram.
    const rice = await products.create(
      shop.tenantId,
      productInput({ name: 'Rice', quantityType: 'DECIMAL', unitOfMeasure: 'kg' }),
    );
    await prisma.branchInventory.create({
      data: {
        tenantId: shop.tenantId,
        branchId: shop.branchId,
        productId: rice.id,
        quantityOnHand: 12.345,
      },
    });

    const cell = await prisma.branchInventory.findFirstOrThrow({
      where: { productId: rice.id },
    });
    expect(cell.quantityOnHand.toFixed(3)).toBe('12.345');
  });

  it('keeps three places and no more', async () => {
    // A fourth place is truncated by the column, which is exactly why D113b §3
    // caps entry at three where the operator can still see it.
    const rice = await products.create(
      shop.tenantId,
      productInput({ name: 'Rice', quantityType: 'DECIMAL', unitOfMeasure: 'kg' }),
    );
    await prisma.branchInventory.create({
      data: {
        tenantId: shop.tenantId,
        branchId: shop.branchId,
        productId: rice.id,
        quantityOnHand: 1.2349,
      },
    });

    const cell = await prisma.branchInventory.findFirstOrThrow({
      where: { productId: rice.id },
    });
    expect(cell.quantityOnHand.toFixed(3)).toBe('1.235');
  });
});

describe('6.2 — the flag reaches the till', () => {
  it('the sellable read model carries quantityType and the unit', async () => {
    // The till cannot intercept what it cannot see. Without this the cart has no
    // way to know a numpad is needed, and `6.3` would have to guess from the
    // product name — which D56 forbids.
    const rice = await products.create(
      shop.tenantId,
      productInput({ name: 'Rice', quantityType: 'DECIMAL', unitOfMeasure: 'kg', unitPrice: 200 }),
    );

    const page = await sellable.list(shop.tenantId, { page: 1, pageSize: 100 } as never);
    const item = page.items.find((i) => i.id === rice.id);

    expect(item).toBeDefined();
    expect(item!.quantityType).toBe('DECIMAL');
    expect(item!.unitOfMeasure).toBe('kg');
  });

  it('a whole product reports WHOLE and no unit', async () => {
    // NEGATIVE control. Without it the assertion above would pass for a read
    // model that hard-coded DECIMAL, or that reported whatever the last product
    // happened to be.
    const shirt = await products.create(shop.tenantId, productInput({ name: 'A Shirt' }));

    const page = await sellable.list(shop.tenantId, { page: 1, pageSize: 100 } as never);
    const item = page.items.find((i) => i.id === shirt.id);

    expect(item!.quantityType).toBe('WHOLE');
    expect(item!.unitOfMeasure).toBeNull();
  });

  it('both kinds arrive in the SAME response, distinguishable', async () => {
    // The shape the till actually receives: a basket screen shows rice beside
    // shirts, and each row has to be right on its own.
    const rice = await products.create(
      shop.tenantId,
      productInput({ name: 'Rice', quantityType: 'DECIMAL', unitOfMeasure: 'kg' }),
    );
    const shirt = await products.create(shop.tenantId, productInput({ name: 'A Shirt' }));

    const page = await sellable.list(shop.tenantId, { page: 1, pageSize: 100 } as never);
    const byId = new Map(page.items.map((i) => [i.id, i]));

    expect(byId.get(rice.id)!.quantityType).toBe('DECIMAL');
    expect(byId.get(shirt.id)!.quantityType).toBe('WHOLE');
  });
});
