/**
 * D125 / D125a — the tenant option library, and the links from a product's own
 * dimensions into it (Phase 5, step `5.1`).
 *
 * ## What can only be proven here, not in a unit spec
 *
 *  • `@@unique([tenantId, name])` — that two tenants may both own `Size`, and
 *    one tenant may not own it twice. A mocked repository proves neither.
 *  • `@@unique([definitionId, code])` and `([definitionId, name])`.
 *  • `ON DELETE SET NULL` on the three optional FKs. This is the whole safety
 *    argument of D125 and it lives in the database, not in TypeScript.
 *  • That the delete guard is load-bearing: without it the database would
 *    ACCEPT the delete and silently unmap every product that adopted the scale.
 *  • That an unmapped dimension behaves exactly as it did before this table
 *    existed — the additive guarantee, asserted rather than assumed.
 *
 * ## What makes these assertions non-vacuous (D30)
 *
 * The additive guarantee is asserted against a product with NO links beside one
 * WITH links, in the same database. "The linked product works" alone would pass
 * for an implementation that had quietly made links mandatory. Every refusal is
 * paired with the neighbouring case that must be accepted, so a service that
 * refused everything would fail as loudly as one that refused nothing. The
 * mutation proof at the end runs the delete guard's assertions against the
 * version without the guard.
 */

import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
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
import { SalesModule } from '../../../src/modules/sales/sales.module';
import { AttributeLibraryService } from '../../../src/modules/products/attribute-library/attribute-library.service';
import { ProductVariantsService } from '../../../src/modules/products/variants/product-variants.service';
import { CreateAttributeDefinitionDto } from '../../../src/modules/products/attribute-library/dto/attribute-library.dto';
import { ReplaceVariationsDto } from '../../../src/modules/products/variants/dto/variation-dimensions.dto';

import { connectTestPrisma, disconnectTestPrisma } from '../prisma-test-client';
import { resetDatabase } from '../db-reset';
import { seedTileShopWithQuickBooks, seedTenant, type SeededTenant } from '../fixtures';

let prisma: PrismaClient;
let testModule: TestingModule;
let library: AttributeLibraryService;
let variants: ProductVariantsService;
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
  library = testModule.get(AttributeLibraryService);
  variants = testModule.get(ProductVariantsService);
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
  await prisma.product.update({
    where: { id: shop.productAId },
    data: { hasVariants: true },
  });
});

function createDto(over: Partial<CreateAttributeDefinitionDto> = {}): CreateAttributeDefinitionDto {
  return Object.assign(new CreateAttributeDefinitionDto(), {
    name: 'Size',
    options: [
      { name: 'Small', code: 'S' },
      { name: 'Medium', code: 'M' },
      { name: 'Large', code: 'L' },
    ],
    ...over,
  });
}

function variationsDto(dimensions: unknown[]): ReplaceVariationsDto {
  return Object.assign(new ReplaceVariationsDto(), { dimensions });
}

// ── The library itself ───────────────────────────────────────────────────────

describe('the option library', () => {
  it('stores a definition with its options in declared order', async () => {
    const created = await library.create(shop.tenantId, createDto());

    expect(created.name).toBe('Size');
    expect(created.options.map((o) => o.code)).toEqual(['S', 'M', 'L']);
    expect(created.options.map((o) => o.position)).toEqual([0, 1, 2]);
    expect(created.linkedDimensionCount).toBe(0);

    const listed = await library.list(shop.tenantId);
    expect(listed.map((d) => d.name)).toEqual(['Size']);
  });

  it('normalises a typed code and refuses one that cannot be normalised', async () => {
    const created = await library.create(
      shop.tenantId,
      createDto({ options: [{ name: 'Extra Large', code: ' extra large ' }] }),
    );
    expect(created.options[0].code).toBe('EXTRA-LARGE');

    await expect(
      library.create(
        shop.tenantId,
        createDto({ name: 'Broken', options: [{ name: 'Nothing', code: '***' }] }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('stores a swatch on a colour option and refuses a non-colour', async () => {
    const created = await library.create(
      shop.tenantId,
      createDto({
        name: 'Colour',
        options: [{ name: 'Black', code: 'BLK', swatchHex: '#1a1a1a' }],
      }),
    );
    expect(created.options[0].swatchHex).toBe('#1A1A1A');

    await expect(
      library.create(
        shop.tenantId,
        createDto({ name: 'Other', options: [{ name: 'Reddish', code: 'RED', swatchHex: 'red' }] }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses a second definition of the same name, and allows another tenant the same one', async () => {
    await library.create(shop.tenantId, createDto());
    await expect(library.create(shop.tenantId, createDto())).rejects.toBeInstanceOf(
      ConflictException,
    );

    // The unique key is (tenantId, name), so a second tenant owning "Size" is
    // the case that proves it is scoped rather than global.
    const other = await seedTenant(prisma, {
      prefix: 'other',
      name: 'Second Shop',
      slug: 'second-shop',
    });
    const theirs = await library.create(other.tenantId, createDto());
    expect(theirs.name).toBe('Size');
  });

  it('refuses two options that would share a code, before the database has to', async () => {
    // Caught in the service so the message can name BOTH values. A P2002 knows
    // a constraint was violated but not which pair collided.
    await expect(
      library.create(
        shop.tenantId,
        createDto({
          options: [
            { name: 'Black', code: 'blk' },
            { name: 'Charcoal', code: 'BLK' },
          ],
        }),
      ),
    ).rejects.toThrow(/BLK/);
  });

  it('binds a definition to a category, and refuses another tenant category', async () => {
    const category = await prisma.productCategory.create({
      data: { tenantId: shop.tenantId, name: 'Footwear' },
    });
    const bound = await library.create(
      shop.tenantId,
      createDto({ name: 'Size - footwear', categoryId: category.id }),
    );
    expect(bound.categoryId).toBe(category.id);
    expect(bound.categoryName).toBe('Footwear');

    const other = await seedTenant(prisma, {
      prefix: 'cat',
      name: 'Third Shop',
      slug: 'third-shop',
    });
    const foreign = await prisma.productCategory.create({
      data: { tenantId: other.tenantId, name: 'Theirs' },
    });
    await expect(
      library.create(shop.tenantId, createDto({ name: 'Nope', categoryId: foreign.id })),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('is scoped per tenant on every read', async () => {
    await library.create(shop.tenantId, createDto());
    const other = await seedTenant(prisma, {
      prefix: 'iso',
      name: 'Isolated',
      slug: 'isolated-shop',
    });

    expect(await library.list(other.tenantId)).toEqual([]);

    const mine = (await library.list(shop.tenantId))[0];
    await expect(library.get(other.tenantId, mine.id)).rejects.toBeInstanceOf(NotFoundException);
  });
});

// ── Links from a product's dimensions ────────────────────────────────────────

describe('mapping a product dimension to the library', () => {
  async function seedSizeLibrary() {
    return library.create(shop.tenantId, createDto());
  }

  it('round-trips a dimension and option link through PUT /variations', async () => {
    const size = await seedSizeLibrary();
    const small = size.options.find((o) => o.code === 'S')!;

    await variants.replaceVariations(
      shop.tenantId,
      shop.productAId,
      variationsDto([
        {
          name: 'Size',
          attributeDefinitionId: size.id,
          options: [{ name: 'Small', attributeOptionId: small.id }],
        },
      ]),
    );

    const read = await variants.listVariations(shop.tenantId, shop.productAId);
    expect(read.dimensions[0].attributeDefinitionId).toBe(size.id);
    expect(read.dimensions[0].options[0].attributeOptionId).toBe(small.id);

    const counted = await library.get(shop.tenantId, size.id);
    expect(counted.linkedDimensionCount).toBe(1);
  });

  it('leaves an unmapped dimension working exactly as before — the additive guarantee', async () => {
    // No library involved at all. This is the shape every existing product in
    // every existing tenant is in, and it must be untouched by D125.
    await variants.replaceVariations(
      shop.tenantId,
      shop.productAId,
      variationsDto([{ name: 'Packaging', options: [{ name: 'Box' }, { name: 'Loose' }] }]),
    );

    const read = await variants.listVariations(shop.tenantId, shop.productAId);
    expect(read.dimensions).toHaveLength(1);
    expect(read.dimensions[0].name).toBe('Packaging');
    expect(read.dimensions[0].attributeDefinitionId).toBeNull();
    expect(read.dimensions[0].options.map((o) => o.name)).toEqual(['Box', 'Loose']);
    expect(read.dimensions[0].options.every((o) => o.attributeOptionId === null)).toBe(true);
  });

  it('omitting the field leaves an existing mapping alone; null clears it', async () => {
    const size = await seedSizeLibrary();
    await variants.replaceVariations(
      shop.tenantId,
      shop.productAId,
      variationsDto([
        { name: 'Size', attributeDefinitionId: size.id, options: [{ name: 'Small' }] },
      ]),
    );

    // A client that predates the library sends no link field at all. It must
    // not silently unmap what an operator mapped by hand.
    await variants.replaceVariations(
      shop.tenantId,
      shop.productAId,
      variationsDto([{ name: 'Size', options: [{ name: 'Small' }] }]),
    );
    let read = await variants.listVariations(shop.tenantId, shop.productAId);
    expect(read.dimensions[0].attributeDefinitionId).toBe(size.id);

    // An explicit null is the deliberate act of unmapping.
    await variants.replaceVariations(
      shop.tenantId,
      shop.productAId,
      variationsDto([
        { name: 'Size', attributeDefinitionId: null, options: [{ name: 'Small' }] },
      ]),
    );
    read = await variants.listVariations(shop.tenantId, shop.productAId);
    expect(read.dimensions[0].attributeDefinitionId).toBeNull();
  });

  it('refuses a link to another tenant library', async () => {
    const other = await seedTenant(prisma, {
      prefix: 'xt',
      name: 'Cross Tenant',
      slug: 'cross-tenant',
    });
    const theirs = await library.create(other.tenantId, createDto());

    await expect(
      variants.replaceVariations(
        shop.tenantId,
        shop.productAId,
        variationsDto([
          { name: 'Size', attributeDefinitionId: theirs.id, options: [{ name: 'Small' }] },
        ]),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses an option mapped to a different attribute than its dimension', async () => {
    const size = await seedSizeLibrary();
    const colour = await library.create(
      shop.tenantId,
      createDto({ name: 'Colour', options: [{ name: 'Black', code: 'BLK' }] }),
    );
    const black = colour.options[0];

    // "Size / Black" would generate a nonsense SKU segment. Nothing in the
    // database prevents it — both columns are independent nullable FKs.
    await expect(
      variants.replaceVariations(
        shop.tenantId,
        shop.productAId,
        variationsDto([
          {
            name: 'Size',
            attributeDefinitionId: size.id,
            options: [{ name: 'Small', attributeOptionId: black.id }],
          },
        ]),
      ),
    ).rejects.toThrow(/different attribute/i);
  });

  it('refuses an option link while its dimension is unmapped', async () => {
    const size = await seedSizeLibrary();
    const small = size.options.find((o) => o.code === 'S')!;

    await expect(
      variants.replaceVariations(
        shop.tenantId,
        shop.productAId,
        variationsDto([{ name: 'Size', options: [{ name: 'Small', attributeOptionId: small.id }] }]),
      ),
    ).rejects.toThrow(/dimension/i);
  });
});

// ── Deleting, and what the database would allow ──────────────────────────────

describe('retiring a library entry', () => {
  it('refuses to delete a definition a product is mapped to, naming the count', async () => {
    const size = await library.create(shop.tenantId, createDto());
    await variants.replaceVariations(
      shop.tenantId,
      shop.productAId,
      variationsDto([
        { name: 'Size', attributeDefinitionId: size.id, options: [{ name: 'Small' }] },
      ]),
    );

    await expect(library.remove(shop.tenantId, size.id)).rejects.toThrow(/1 product dimension/);

    // And the mapping is still there — a refused delete changed nothing.
    const read = await variants.listVariations(shop.tenantId, shop.productAId);
    expect(read.dimensions[0].attributeDefinitionId).toBe(size.id);
  });

  it('allows the delete once nothing points at it', async () => {
    const size = await library.create(shop.tenantId, createDto());
    await variants.replaceVariations(
      shop.tenantId,
      shop.productAId,
      variationsDto([
        { name: 'Size', attributeDefinitionId: size.id, options: [{ name: 'Small' }] },
      ]),
    );
    await variants.replaceVariations(
      shop.tenantId,
      shop.productAId,
      variationsDto([
        { name: 'Size', attributeDefinitionId: null, options: [{ name: 'Small' }] },
      ]),
    );

    await library.remove(shop.tenantId, size.id);
    expect(await library.list(shop.tenantId)).toEqual([]);
  });

  it('refuses to remove a library option a product option still uses', async () => {
    const size = await library.create(shop.tenantId, createDto());
    const small = size.options.find((o) => o.code === 'S')!;
    await variants.replaceVariations(
      shop.tenantId,
      shop.productAId,
      variationsDto([
        {
          name: 'Size',
          attributeDefinitionId: size.id,
          options: [{ name: 'Small', attributeOptionId: small.id }],
        },
      ]),
    );

    await expect(
      library.update(shop.tenantId, size.id, {
        options: [
          { name: 'Medium', code: 'M' },
          { name: 'Large', code: 'L' },
        ],
      }),
    ).rejects.toThrow(/cannot be removed/i);

    // Untouched: a refused prune must not have deleted the other two either.
    const after = await library.get(shop.tenantId, size.id);
    expect(after.options.map((o) => o.code)).toEqual(['S', 'M', 'L']);
  });

  /**
   * Mutation proof (D30 §5) — the delete guard is load-bearing.
   *
   * Every FK into the library is `ON DELETE SET NULL`, deliberately, so that
   * retiring a definition can never destroy a product's own dimension. That
   * choice is exactly why the service guard has to exist: without it the delete
   * SUCCEEDS and silently unmaps every product that adopted the scale.
   *
   * This runs the deletion the guard prevents, straight at the database, and
   * asserts the damage — which is what proves the guard above is not decorative.
   */
  it('CAUGHT: deleting without the guard silently unmaps the product', async () => {
    const size = await library.create(shop.tenantId, createDto());
    const small = size.options.find((o) => o.code === 'S')!;
    await variants.replaceVariations(
      shop.tenantId,
      shop.productAId,
      variationsDto([
        {
          name: 'Size',
          attributeDefinitionId: size.id,
          options: [{ name: 'Small', attributeOptionId: small.id }],
        },
      ]),
    );

    // The mutant: what `remove()` would do with the guard removed.
    await prisma.attributeDefinition.delete({ where: { id: size.id } });

    const read = await variants.listVariations(shop.tenantId, shop.productAId);
    // No error was raised anywhere. The dimension survived — that is SET NULL
    // doing its job — but the mapping is gone, with nothing to notice it.
    expect(read.dimensions).toHaveLength(1);
    expect(read.dimensions[0].name).toBe('Size');
    expect(read.dimensions[0].attributeDefinitionId).toBeNull();
    expect(read.dimensions[0].options[0].attributeOptionId).toBeNull();
  });
});
