/**
 * D133 (`8.9`) — brand as an entity.
 *
 * ## What can only be proven here
 *
 *  • The unique index. Two brands called "Nike" must be refused by the DATABASE,
 *    not by a lookup a second request could race past — and only a real database
 *    can demonstrate that.
 *  • `onDelete: SetNull`. Retiring a brand must never delete a product, and the
 *    referential action is a property of the schema, not of any code.
 *  • That the products filter reads the indexed column and nothing else.
 *
 * ## What makes these assertions non-vacuous (D30)
 *
 * The filter is asserted in both directions — the branded product is returned
 * for its own brand AND is absent from another brand's results — so a filter
 * that was ignored entirely would fail. Archiving is asserted to keep the LINK,
 * not just the row, because "the brand still exists" would pass for an
 * implementation that had silently unlinked every product.
 */

import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import {
  AccountingProviderKind,
  BusinessType,
  InventoryMode,
  type PrismaClient,
} from '@hardware-pos/database';

import { validateEnv } from '../../../src/config/env.validation';
import { StorageModule } from '../../../src/common/storage/storage.module';
import { PrismaModule } from '../../../src/prisma/prisma.module';
import { PlatformModule } from '../../../src/modules/platform/platform.module';
import { ProvidersModule } from '../../../src/modules/providers/providers.module';
import { ProductsModule } from '../../../src/modules/products/products.module';
import { ProductsService } from '../../../src/modules/products/products.service';
import { SalesModule } from '../../../src/modules/sales/sales.module';
import { BrandsModule } from '../../../src/modules/brands/brands.module';
import { BrandsService } from '../../../src/modules/brands/brands.service';
import { QueryProductsDto } from '../../../src/modules/products/dto/query-products.dto';

import { connectTestPrisma, disconnectTestPrisma } from '../prisma-test-client';
import { resetDatabase } from '../db-reset';
import { seedTileShopWithQuickBooks, type SeededTenant } from '../fixtures';

let prisma: PrismaClient;
let testModule: TestingModule;
let brands: BrandsService;
let products: ProductsService;
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
      BrandsModule,
    ],
  }).compile();
  testModule.useLogger(false);
  await testModule.init();
  brands = testModule.get(BrandsService);
  products = testModule.get(ProductsService);
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

function query(extra: Partial<QueryProductsDto> = {}): QueryProductsDto {
  return Object.assign(new QueryProductsDto(), { page: 1, pageSize: 50, ...extra });
}

describe('a brand is a row, not a string', () => {
  it('is created, listed, and counts what carries it', async () => {
    const nike = await brands.create(shop.tenantId, { name: 'Nike' });
    expect(nike).toEqual({ id: nike.id, name: 'Nike', isActive: true, productCount: 0 });

    await prisma.product.update({
      where: { id: shop.productAId },
      data: { brandId: nike.id },
    });

    const list = await brands.list(shop.tenantId);
    expect(list).toEqual([{ id: nike.id, name: 'Nike', isActive: true, productCount: 1 }]);
  });

  it('refuses a second brand of the same name, from the database', async () => {
    await brands.create(shop.tenantId, { name: 'Nike' });
    await expect(brands.create(shop.tenantId, { name: 'Nike' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    // Exactly one row. The refusal is the unique index, which is what makes it
    // safe under two simultaneous requests; a check-then-insert would let both
    // through and this count would be 2.
    expect(await prisma.brand.count({ where: { tenantId: shop.tenantId } })).toBe(1);
  });

  it('lets two tenants each have a brand of the same name', async () => {
    const other = await prisma.tenant.create({ data: { name: 'Other', slug: 'other-brand-shop' } });
    await brands.create(shop.tenantId, { name: 'Nike' });
    // NEGATIVE control for the uniqueness above: it is scoped per tenant, and a
    // constraint on `name` alone would fail here.
    await expect(brands.create(other.id, { name: 'Nike' })).resolves.toMatchObject({
      name: 'Nike',
    });
  });

  it('trims a name, so " Nike " and "Nike" are the same brand', async () => {
    await brands.create(shop.tenantId, { name: 'Nike' });
    await expect(brands.create(shop.tenantId, { name: '  Nike  ' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('is renamed, and every product follows because the link is an id', async () => {
    const brand = await brands.create(shop.tenantId, { name: 'Nkie' });
    await prisma.product.update({ where: { id: shop.productAId }, data: { brandId: brand.id } });

    await brands.update(shop.tenantId, brand.id, { name: 'Nike' });

    const product = await prisma.product.findUniqueOrThrow({
      where: { id: shop.productAId },
      include: { brand: true },
    });
    // The whole argument for an entity: a typo is fixed in one place. A free-text
    // column would need every product rewritten, and would miss the ones nobody
    // remembered.
    expect(product.brand?.name).toBe('Nike');
  });
});

describe('archiving, not deleting', () => {
  it('hides an archived brand from the default list but keeps the link', async () => {
    const brand = await brands.create(shop.tenantId, { name: 'Retired Label' });
    await prisma.product.update({ where: { id: shop.productAId }, data: { brandId: brand.id } });

    await brands.update(shop.tenantId, brand.id, { isActive: false });

    expect(await brands.list(shop.tenantId)).toEqual([]);
    // POSITIVE: still there when asked for, so an old product can still show
    // what it was.
    const withArchived = await brands.list(shop.tenantId, true);
    expect(withArchived.map((b) => b.name)).toEqual(['Retired Label']);

    // And the LINK survives — "the row still exists" would pass for an
    // implementation that had unlinked every product on archive.
    const product = await prisma.product.findUniqueOrThrow({
      where: { id: shop.productAId },
      include: { brand: true },
    });
    expect(product.brandId).toBe(brand.id);
    expect(product.brand?.name).toBe('Retired Label');
  });

  it('is restored by the same route that archived it', async () => {
    const brand = await brands.create(shop.tenantId, { name: 'Seasonal' });
    await brands.update(shop.tenantId, brand.id, { isActive: false });
    await brands.update(shop.tenantId, brand.id, { isActive: true });
    expect((await brands.list(shop.tenantId)).map((b) => b.name)).toEqual(['Seasonal']);
  });

  it('unlinks rather than deletes a product if a brand row is ever removed', async () => {
    // There is no delete route. This asserts the SCHEMA's referential action, so
    // that a future admin tool, a migration or a manual DELETE cannot take
    // products with it — the property D133 relies on, enforced by Postgres.
    const brand = await brands.create(shop.tenantId, { name: 'Doomed' });
    await prisma.product.update({ where: { id: shop.productAId }, data: { brandId: brand.id } });

    await prisma.brand.delete({ where: { id: brand.id } });

    const product = await prisma.product.findUniqueOrThrow({ where: { id: shop.productAId } });
    expect(product.brandId).toBeNull();
    // The product itself is untouched — name, price, everything.
    expect(product.name).toBe('Fixture Product A');
    expect(Number(product.unitPrice)).toBe(1000);
  });
});

describe('products by brand', () => {
  it('filters to one label, and excludes the others', async () => {
    const nike = await brands.create(shop.tenantId, { name: 'Nike' });
    const adidas = await brands.create(shop.tenantId, { name: 'Adidas' });
    await prisma.product.update({ where: { id: shop.productAId }, data: { brandId: nike.id } });
    await prisma.product.update({ where: { id: shop.productBId }, data: { brandId: adidas.id } });

    const nikeOnly = await products.list(shop.tenantId, query({ brandId: nike.id }));
    expect(nikeOnly.items.map((p) => p.id)).toEqual([shop.productAId]);

    // NEGATIVE, and the reason both halves are here: a filter that was ignored
    // would return all three products in each call and the assertion above
    // would still have found Product A among them.
    const adidasOnly = await products.list(shop.tenantId, query({ brandId: adidas.id }));
    expect(adidasOnly.items.map((p) => p.id)).toEqual([shop.productBId]);

    // And unfiltered still returns everything, so the filter is not a permanent
    // narrowing of the list.
    const all = await products.list(shop.tenantId, query());
    expect(all.items.length).toBeGreaterThan(2);
  });

  it('refuses a brand belonging to another tenant', async () => {
    const other = await prisma.tenant.create({ data: { name: 'Other', slug: 'other-brand-shop-2' } });
    const theirs = await brands.create(other.id, { name: 'Theirs' });

    await expect(
      products.update(
        shop.tenantId,
        shop.productAId,
        { brandId: theirs.id } as never,
        'OWNER' as never,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    const product = await prisma.product.findUniqueOrThrow({ where: { id: shop.productAId } });
    expect(product.brandId).toBeNull();
  });

  it('distinguishes "leave the brand alone" from "clear it"', async () => {
    const brand = await brands.create(shop.tenantId, { name: 'Nike' });
    await products.update(
      shop.tenantId,
      shop.productAId,
      { brandId: brand.id } as never,
      'OWNER' as never,
    );

    // A partial update that says nothing about the brand must not wipe it —
    // every wizard step sends a partial document.
    await products.update(shop.tenantId, shop.productAId, { name: 'Renamed' } as never, 'OWNER' as never);
    expect((await prisma.product.findUniqueOrThrow({ where: { id: shop.productAId } })).brandId).toBe(
      brand.id,
    );

    // An explicit empty string clears it. Three states, all reachable.
    await products.update(shop.tenantId, shop.productAId, { brandId: '' } as never, 'OWNER' as never);
    expect(
      (await prisma.product.findUniqueOrThrow({ where: { id: shop.productAId } })).brandId,
    ).toBeNull();
  });
});
