/**
 * D150 — a tenant defines its own business details.
 *
 * The extra per-product fields the wizard collects into `Product.attributes`
 * (D64) were declared per DOMAIN and hardcoded. A retail workspace sells
 * clothing or groceries and those track different things, so retail — and only
 * retail — may replace the list.
 *
 * ## What makes these assertions non-vacuous (D30)
 *
 * Every refusal is paired with the case that must still succeed. "Removing a
 * field in use is refused" alone would pass for a service that refused every
 * write; "a retail tenant may configure" alone would pass for one that had no
 * capability check at all. Both halves are asserted, in the same shape.
 *
 * The isolation cases assert a domain that MAY configure and one that MAY NOT,
 * against the same code path, because a gate that reads one business type by
 * name is exactly the if-chain D56 exists to prevent.
 */
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { BadRequestException, ConflictException } from '@nestjs/common';
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
import { SalesModule } from '../../../src/modules/sales/sales.module';
import { ProductsModule } from '../../../src/modules/products/products.module';
import { BusinessDetailsService } from '../../../src/modules/products/business-details.service';
import { ProductAttributesService } from '../../../src/modules/products/product-attributes.service';
import { ProductsService } from '../../../src/modules/products/products.service';
import { SettingsService } from '../../../src/modules/settings/settings.service';

import { connectTestPrisma, disconnectTestPrisma } from '../prisma-test-client';
import { resetDatabase } from '../db-reset';
import { seedTileShopWithQuickBooks, type SeededTenant } from '../fixtures';

let prisma: PrismaClient;
let testModule: TestingModule;
let businessDetails: BusinessDetailsService;
let attributes: ProductAttributesService;
let products: ProductsService;
let settings: SettingsService;
let shop: SeededTenant;

beforeAll(async () => {
  prisma = await connectTestPrisma();
  testModule = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
      StorageModule,
      PrismaModule,
      // The same four `ProductsModule` needs everywhere else in this suite.
      // `ProductsModule` reaches QuickBooks through the provider factories, and
      // `QuickBooksService` injects `JwtService` without importing `JwtModule` —
      // it relies on the global one `AuthModule` registers (see the graph
      // prerequisites in `providers.module.ts`). `SalesModule` is what drags
      // `AuthModule` in, via `DiscountsModule`. Dropping any of the four gives a
      // dependency-resolution failure at compile, not a test failure.
      PlatformModule,
      ProvidersModule,
      SalesModule,
      ProductsModule,
    ],
  }).compile();
  testModule.useLogger(false);
  await testModule.init();

  businessDetails = testModule.get(BusinessDetailsService);
  attributes = testModule.get(ProductAttributesService);
  products = testModule.get(ProductsService);
  settings = testModule.get(SettingsService);
});

afterAll(async () => {
  await testModule.close();
  await disconnectTestPrisma();
});

beforeEach(async () => {
  await resetDatabase(prisma);
  shop = await seedTileShopWithQuickBooks(prisma);
  await becomeA(BusinessType.RETAIL);
});

/** Set the workspace's business type, and drop the settings cache with it. */
async function becomeA(businessType: BusinessType) {
  await prisma.tenantBusinessProfile.deleteMany({ where: { tenantId: shop.tenantId } });
  await prisma.tenantBusinessProfile.create({
    data: {
      tenantId: shop.tenantId,
      businessType,
      inventoryMode: InventoryMode.LOCAL,
      accountingProvider: AccountingProviderKind.NONE,
    },
  });
  /*
   * NOT `settings.invalidate`. That deletes the cache entry, and `getSettings`
   * is synchronous -- it would then return code DEFAULTS until the background
   * refresh lands, so a list stored moments ago reads as absent and this helper
   * would silently erase the very state the test is about. `getSettingsFresh`
   * reads through and repopulates, which is what the service documents it for.
   * (Production never invalidates -- writes go through `persist`, which updates
   * the cache -- so this window is an artefact of the helper, not of the feature.)
   */
  await settings.getSettingsFresh(shop.tenantId);
}

const CLOTHING = [
  { key: 'material', label: 'Material', type: 'text' as const, maxLength: 120 },
  { key: 'fit', label: 'Fit', type: 'enum' as const, options: ['Slim', 'Regular', 'Oversized'] },
  { key: 'season', label: 'Season', type: 'enum' as const, options: ['Summer', 'Winter'] },
];

function productInput(extra: Record<string, unknown> = {}) {
  return { name: 'Test Product', type: 'Inventory', unitPrice: 100, ...extra } as never;
}

describe('a retail workspace defines its own fields', () => {
  it('starts on its business type’s declared list', async () => {
    const config = await businessDetails.getConfig(shop.tenantId);

    expect(config.source).toBe('DOMAIN');
    expect(config.fields.map((f) => f.key)).toContain('material');
  });

  it('replaces the list, and the wizard schema follows', async () => {
    await businessDetails.replace(shop.tenantId, CLOTHING as never);

    const config = await businessDetails.getConfig(shop.tenantId);
    expect(config.source).toBe('TENANT');

    // The ONE resolver: what the wizard fetches is what validation enforces.
    const schema = await attributes.schemaForTenant(shop.tenantId);
    expect(schema.map((f) => f.key)).toEqual(['material', 'fit', 'season']);
  });

  it('supports a calendar date, and refuses a date that does not exist', async () => {
    await businessDetails.replace(shop.tenantId, [
      { key: 'launchDate', label: 'Launch date', type: 'date' },
    ] as never);

    const ok = await products.create(
      shop.tenantId,
      productInput({ attributes: { launchDate: '2026-09-09' } }),
    );
    expect((ok.attributes as Record<string, unknown>).launchDate).toBe('2026-09-09');

    // 31 February parses in some readings and is not a day.
    await expect(
      products.create(shop.tenantId, productInput({ attributes: { launchDate: '2026-02-31' } })),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('an EMPTY list is a real answer, not a reset', async () => {
    // "We track no business details" hides the wizard step. It must not be
    // confused with "never configured", which falls back to the domain list.
    await businessDetails.replace(shop.tenantId, [] as never);

    expect(await attributes.schemaForTenant(shop.tenantId)).toEqual([]);
    expect((await businessDetails.getConfig(shop.tenantId)).source).toBe('TENANT');
  });
});

describe('values are validated against the tenant’s own list', () => {
  beforeEach(async () => {
    await businessDetails.replace(shop.tenantId, CLOTHING as never);
  });

  it('stores a value the list allows', async () => {
    const p = await products.create(
      shop.tenantId,
      productInput({ attributes: { material: 'Cotton', fit: 'Oversized' } }),
    );

    expect(p.attributes).toEqual({ material: 'Cotton', fit: 'Oversized' });
  });

  it('refuses a dropdown value the list does not offer', async () => {
    await expect(
      products.create(shop.tenantId, productInput({ attributes: { fit: 'Baggy' } })),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses a key the tenant removed', async () => {
    // `gender` is declared by the RETAIL domain but not by this tenant's list.
    await expect(
      products.create(shop.tenantId, productInput({ attributes: { gender: 'Men' } })),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('a definition in use cannot be taken away', () => {
  beforeEach(async () => {
    await businessDetails.replace(shop.tenantId, CLOTHING as never);
    await products.create(
      shop.tenantId,
      productInput({ name: 'Shirt', attributes: { material: 'Cotton', fit: 'Slim' } }),
    );
  });

  it('refuses removing a field a product records', async () => {
    /*
     * The reason this rule exists: `validateAttributes` refuses unknown keys,
     * so a product carrying a removed key could never be SAVED again. The
     * operator would delete the field today and find next week that a product
     * will not save, with nothing on screen connecting the two.
     */
    await expect(
      businessDetails.replace(shop.tenantId, CLOTHING.filter((f) => f.key !== 'material') as never),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('refuses removing a dropdown option a product is set to', async () => {
    const withoutSlim = CLOTHING.map((f) =>
      f.key === 'fit' ? { ...f, options: ['Regular', 'Oversized'] } : f,
    );

    await expect(
      businessDetails.replace(shop.tenantId, withoutSlim as never),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('refuses retyping a field out from under its values', async () => {
    const retyped = CLOTHING.map((f) =>
      f.key === 'material' ? { key: 'material', label: 'Material', type: 'boolean' as const } : f,
    );

    await expect(businessDetails.replace(shop.tenantId, retyped as never)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('ALLOWS removing a field nothing records', async () => {
    // The positive half. Without it, every assertion above would pass for a
    // service that refused all removals, which would make the feature useless.
    await businessDetails.replace(
      shop.tenantId,
      CLOTHING.filter((f) => f.key !== 'season') as never,
    );

    expect((await attributes.schemaForTenant(shop.tenantId)).map((f) => f.key)).toEqual([
      'material',
      'fit',
    ]);
  });

  it('ALLOWS renaming a label, which orphans nothing', async () => {
    // The key is the identity; the label is presentation. Renaming the label
    // must stay cheap or operators will avoid tidying their own catalogue.
    const relabelled = CLOTHING.map((f) =>
      f.key === 'material' ? { ...f, label: 'Fabric' } : f,
    );

    await businessDetails.replace(shop.tenantId, relabelled as never);

    const schema = await attributes.schemaForTenant(shop.tenantId);
    expect(schema.find((f) => f.key === 'material')?.label).toBe('Fabric');
    // …and the stored value is untouched.
    const p = await prisma.product.findFirstOrThrow({ where: { name: 'Shirt' } });
    expect((p.attributes as Record<string, unknown>).material).toBe('Cotton');
  });
});

describe('the list is refused where the business type does not offer it', () => {
  it('a hardware workspace cannot configure one', async () => {
    await becomeA(BusinessType.HARDWARE);

    await expect(businessDetails.replace(shop.tenantId, CLOTHING as never)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(businessDetails.getConfig(shop.tenantId)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('a food-service workspace cannot either', async () => {
    // A second refusing domain, so the gate is proven to read the registry
    // rather than naming HARDWARE in an if.
    await becomeA(BusinessType.RESTAURANT);

    await expect(businessDetails.replace(shop.tenantId, CLOTHING as never)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('and keeps serving its own declared schema, unchanged', async () => {
    // The half that proves the refusal did not break the existing feature:
    // hardware declares none, and a hotel's three still arrive.
    await becomeA(BusinessType.HARDWARE);
    expect(await attributes.schemaForTenant(shop.tenantId)).toEqual([]);

    await becomeA(BusinessType.HOTEL);
    expect((await attributes.schemaForTenant(shop.tenantId)).length).toBeGreaterThan(0);
  });

  it('ignores a stored list once the workspace is no longer retail', async () => {
    /*
     * A workspace that changes business type must not keep enforcing the
     * previous type's fields. The stored list is not deleted -- changing back
     * restores it -- but it stops being read.
     */
    await businessDetails.replace(shop.tenantId, CLOTHING as never);
    await becomeA(BusinessType.HARDWARE);

    expect(await attributes.schemaForTenant(shop.tenantId)).toEqual([]);

    await becomeA(BusinessType.RETAIL);
    expect((await attributes.schemaForTenant(shop.tenantId)).map((f) => f.key)).toEqual([
      'material',
      'fit',
      'season',
    ]);
  });
});

describe('the list itself has to make sense', () => {
  it('refuses two fields with one key', async () => {
    await expect(
      businessDetails.replace(shop.tenantId, [
        { key: 'material', label: 'Material', type: 'text' },
        { key: 'material', label: 'Fabric', type: 'text' },
      ] as never),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses a dropdown with no options', async () => {
    await expect(
      businessDetails.replace(shop.tenantId, [
        { key: 'fit', label: 'Fit', type: 'enum', options: [] },
      ] as never),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses a dropdown that lists the same option twice', async () => {
    await expect(
      businessDetails.replace(shop.tenantId, [
        { key: 'fit', label: 'Fit', type: 'enum', options: ['Slim', 'Slim'] },
      ] as never),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses a key that is not addressable', async () => {
    // Reports address these keys. A space or a leading digit is a key that
    // works until somebody writes a query.
    await expect(
      businessDetails.replace(shop.tenantId, [
        { key: 'care instructions', label: 'Care', type: 'text' },
      ] as never),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('existing products keep working', () => {
  it('a product created under the domain list still loads and re-saves', async () => {
    /*
     * The backward-compatibility case. A product created before anybody opened
     * the new tab holds keys from the DOMAIN list; configuring a tenant list
     * that still declares them must leave it saveable.
     */
    const before = await products.create(
      shop.tenantId,
      productInput({ name: 'Old Shirt', attributes: { material: 'Linen' } }),
    );

    await businessDetails.replace(shop.tenantId, CLOTHING as never);

    const reloaded = await prisma.product.findUniqueOrThrow({ where: { id: before.id } });
    expect((reloaded.attributes as Record<string, unknown>).material).toBe('Linen');

    await products.update(
      shop.tenantId,
      before.id,
      { name: 'Old Shirt II', attributes: { material: 'Linen' } } as never,
      'OWNER' as never,
    );

    const after = await prisma.product.findUniqueOrThrow({ where: { id: before.id } });
    expect(after.name).toBe('Old Shirt II');
    expect((after.attributes as Record<string, unknown>).material).toBe('Linen');
  });
});
