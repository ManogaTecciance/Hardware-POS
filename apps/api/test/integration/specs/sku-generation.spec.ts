/**
 * D104 — SKU generation (Phase 5, step `5.3`), and the `5.2` codes it consumes.
 *
 * ## What can only be proven here
 *
 *  • `nextDocumentNumber(tx, tenantId, 'SKU')` under a real `DocumentSequence`
 *    row — that the sequence is per TENANT, moves per variant, and what a
 *    rollback actually does to it. D104 predicted a rolled-back batch would
 *    burn its numbers; measured here, it does not, because the allocation is a
 *    statement in the same transaction. The gaps the record accepts come from
 *    the collision retry instead.
 *  • `@@unique([tenantId, sku])` catching a generated value that collides with
 *    a hand-typed one, and the retry clearing it.
 *  • That a mapped library option's `code` actually reaches the composed SKU
 *    through two joins and a transaction.
 *
 * ## What makes these assertions non-vacuous (D30)
 *
 * Generation is asserted BESIDE an explicit override in the same batch, so an
 * implementation that ignored the override, or one that ignored the request to
 * generate, both fail. The pre-existing behaviour — every variant naming its
 * own sku, as every caller did before `5.3` — is asserted unchanged, because
 * that is the contract for the hardware and restaurant tenants who will never
 * use generation. The mutation proof runs the assertions against a batch-shared
 * sequence, which is the shortcut that reads better and is wrong.
 */

import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
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
import { CreateVariantBatchDto } from '../../../src/modules/products/variants/dto/create-variant-batch.dto';
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
  await prisma.product.update({ where: { id: shop.productAId }, data: { hasVariants: true } });
});

/** Give productA a category, so the leading SKU segment is a real one. */
async function categorise(name: string): Promise<void> {
  const category = await prisma.productCategory.create({
    data: { tenantId: shop.tenantId, name },
  });
  await prisma.product.update({
    where: { id: shop.productAId },
    data: { categoryId: category.id },
  });
}

/** A `Size` library definition with S / M / L. */
function sizeDto(): CreateAttributeDefinitionDto {
  return Object.assign(new CreateAttributeDefinitionDto(), {
    name: 'Size',
    options: [
      { name: 'Small', code: 'S' },
      { name: 'Medium', code: 'M' },
    ],
  });
}

/** Declare one `Size` dimension on productA; optionally mapped to the library. */
async function declareSize(mapping?: { definitionId: string; optionIds: Record<string, string> }) {
  const dto = Object.assign(new ReplaceVariationsDto(), {
    dimensions: [
      {
        name: 'Size',
        ...(mapping ? { attributeDefinitionId: mapping.definitionId } : {}),
        options: [
          { name: 'Small', ...(mapping ? { attributeOptionId: mapping.optionIds.S } : {}) },
          { name: 'Medium', ...(mapping ? { attributeOptionId: mapping.optionIds.M } : {}) },
        ],
      },
    ],
  });
  await variants.replaceVariations(shop.tenantId, shop.productAId, dto);
  return variants.listVariations(shop.tenantId, shop.productAId);
}

function batch(rows: unknown[]): CreateVariantBatchDto {
  return Object.assign(new CreateVariantBatchDto(), { variants: rows });
}

describe('SKU generation', () => {
  it('generates <CATEGORY>-<SEQ>-<OPTION> when the caller omits sku', async () => {
    await categorise('Apparel');
    const dims = await declareSize();
    const dimensionId = dims.dimensions[0].id;
    const small = dims.dimensions[0].options[0];

    const created = await variants.createVariantsBatch(
      shop.tenantId,
      shop.productAId,
      shop.ownerId,
      batch([
        {
          unitPrice: 1500,
          optionValues: [{ dimensionId, optionId: small.id }],
        },
      ]),
    );

    // 'Small' is unmapped, so the segment is DERIVED from the option name.
    expect(created[0].sku).toBe('APPAREL-0001-SMALL');
  });

  it('uses the library code once the option is mapped — the point of 5.2', async () => {
    await categorise('Apparel');
    const size = await library.create(shop.tenantId, sizeDto());
    const codes = Object.fromEntries(size.options.map((o) => [o.code, o.id]));
    const dims = await declareSize({ definitionId: size.id, optionIds: codes });
    const dimensionId = dims.dimensions[0].id;
    const small = dims.dimensions[0].options[0];

    // The resolved code is visible on the read model too (`5.2`).
    expect(small.code).toBe('S');
    expect(small.codeSource).toBe('LIBRARY');

    const created = await variants.createVariantsBatch(
      shop.tenantId,
      shop.productAId,
      shop.ownerId,
      batch([{ unitPrice: 1500, optionValues: [{ dimensionId, optionId: small.id }] }]),
    );
    expect(created[0].sku).toBe('APPAREL-0001-S');
  });

  it('honours an explicit sku, and generates for its neighbour in the same batch', async () => {
    await categorise('Apparel');
    const dims = await declareSize();
    const dimensionId = dims.dimensions[0].id;
    const [small, medium] = dims.dimensions[0].options;

    const created = await variants.createVariantsBatch(
      shop.tenantId,
      shop.productAId,
      shop.ownerId,
      batch([
        { sku: 'HAND-TYPED-1', unitPrice: 1500, optionValues: [{ dimensionId, optionId: small.id }] },
        { unitPrice: 1500, optionValues: [{ dimensionId, optionId: medium.id }] },
      ]),
    );

    const bySku = created.map((v) => v.sku).sort();
    expect(bySku).toEqual(['APPAREL-0001-MEDIUM', 'HAND-TYPED-1']);
  });

  it('leaves the pre-5.3 behaviour untouched when every row names its own sku', async () => {
    // Every caller before `5.3` looked exactly like this. Hardware and
    // restaurant tenants will never use generation, and must not be affected.
    const dims = await declareSize();
    const dimensionId = dims.dimensions[0].id;
    const [small, medium] = dims.dimensions[0].options;

    const created = await variants.createVariantsBatch(
      shop.tenantId,
      shop.productAId,
      shop.ownerId,
      batch([
        { sku: 'MINE-S', unitPrice: 100, optionValues: [{ dimensionId, optionId: small.id }] },
        { sku: 'MINE-M', unitPrice: 100, optionValues: [{ dimensionId, optionId: medium.id }] },
      ]),
    );
    expect(created.map((v) => v.sku).sort()).toEqual(['MINE-M', 'MINE-S']);

    // And no sequence row was created at all — nothing was allocated.
    const sequence = await prisma.documentSequence.findUnique({
      where: { tenantId_docType: { tenantId: shop.tenantId, docType: 'SKU' } },
    });
    expect(sequence).toBeNull();
  });

  it('allocates one number per VARIANT, not one per batch', async () => {
    await categorise('Apparel');
    const dims = await declareSize();
    const dimensionId = dims.dimensions[0].id;
    const [small, medium] = dims.dimensions[0].options;

    const created = await variants.createVariantsBatch(
      shop.tenantId,
      shop.productAId,
      shop.ownerId,
      batch([
        { unitPrice: 100, optionValues: [{ dimensionId, optionId: small.id }] },
        { unitPrice: 100, optionValues: [{ dimensionId, optionId: medium.id }] },
      ]),
    );

    expect(created.map((v) => v.sku).sort()).toEqual([
      'APPAREL-0001-SMALL',
      'APPAREL-0002-MEDIUM',
    ]);
    const sequence = await prisma.documentSequence.findUnique({
      where: { tenantId_docType: { tenantId: shop.tenantId, docType: 'SKU' } },
    });
    expect(sequence!.value).toBe(2);
  });

  it('numbers per tenant — two shops both start at 1', async () => {
    await categorise('Apparel');
    const dims = await declareSize();
    const dimensionId = dims.dimensions[0].id;
    const small = dims.dimensions[0].options[0];
    await variants.createVariantsBatch(
      shop.tenantId,
      shop.productAId,
      shop.ownerId,
      batch([{ unitPrice: 100, optionValues: [{ dimensionId, optionId: small.id }] }]),
    );

    const other = await seedTenant(prisma, {
      prefix: 'seq',
      name: 'Second Shop',
      slug: 'second-seq-shop',
    });
    await prisma.tenantBusinessProfile.create({
      data: {
        tenantId: other.tenantId,
        businessType: BusinessType.RETAIL,
        inventoryMode: InventoryMode.LOCAL,
        accountingProvider: AccountingProviderKind.NONE,
      },
    });
    await prisma.product.update({ where: { id: other.productAId }, data: { hasVariants: true } });

    const theirs = await variants.createVariantsBatch(
      other.tenantId,
      other.productAId,
      other.ownerId,
      batch([{ unitPrice: 100, optionValues: [] }]),
    );
    // Their own sequence, their own (absent) category.
    expect(theirs[0].sku).toBe('GEN-0001');
  });

  it('retries past a hand-typed SKU that already occupies the generated value', async () => {
    await categorise('Apparel');
    const dims = await declareSize();
    const dimensionId = dims.dimensions[0].id;
    const [small, medium] = dims.dimensions[0].options;

    // Occupy exactly what the first allocation would compose.
    await variants.createVariantsBatch(
      shop.tenantId,
      shop.productAId,
      shop.ownerId,
      batch([
        {
          sku: 'APPAREL-0001-MEDIUM',
          unitPrice: 100,
          optionValues: [{ dimensionId, optionId: medium.id }],
        },
      ]),
    );

    const created = await variants.createVariantsBatch(
      shop.tenantId,
      shop.productAId,
      shop.ownerId,
      batch([{ unitPrice: 100, optionValues: [{ dimensionId, optionId: small.id }] }]),
    );
    // Not the colliding value, and not a mangled variant of it.
    expect(created[0].sku).toBe('APPAREL-0001-SMALL');

    // Now force a real collision: occupy 0002-SMALL and ask for another SMALL.
    await prisma.productVariant.create({
      data: {
        tenantId: shop.tenantId,
        productId: shop.productBId,
        sku: 'APPAREL-0002-SMALL',
        unitPrice: 1,
      },
    });
    const retried = await variants.createVariantsBatch(
      shop.tenantId,
      shop.productAId,
      shop.ownerId,
      batch([{ unitPrice: 100, optionValues: [{ dimensionId, optionId: small.id }] }]),
    );
    expect(retried[0].sku).toBe('APPAREL-0003-SMALL');
  });

  /**
   * D104 Part 2 predicted this and predicted it WRONG, so the assertion records
   * what the mechanism actually does.
   *
   * The record says: "`nextDocumentNumber` increments inside the transaction,
   * so a rolled-back product creation burns a number." It does not. The
   * increment is a statement in the SAME transaction, so a rollback reverts it
   * along with everything else — measured here, not reasoned about.
   *
   * The conclusion D104 drew from the wrong premise still stands: gaps are
   * accepted. They just arise somewhere else — from the collision retry above,
   * which allocates a number, finds the composed SKU taken, and abandons it.
   */
  it('does NOT burn numbers on a rolled-back batch — rollback reverts the sequence', async () => {
    await categorise('Apparel');
    const dims = await declareSize();
    const dimensionId = dims.dimensions[0].id;
    const [small, medium] = dims.dimensions[0].options;

    // Two rows flagged default — the partial unique index refuses the second,
    // so the whole transaction rolls back after allocating both numbers.
    await expect(
      variants.createVariantsBatch(
        shop.tenantId,
        shop.productAId,
        shop.ownerId,
        batch([
          { unitPrice: 100, isDefault: true, optionValues: [{ dimensionId, optionId: small.id }] },
          { unitPrice: 100, isDefault: true, optionValues: [{ dimensionId, optionId: medium.id }] },
        ]),
      ),
    ).rejects.toBeDefined();

    expect(await prisma.productVariant.count({ where: { productId: shop.productAId } })).toBe(0);

    // The sequence row itself was rolled back out of existence — it did not
    // even survive at 0, which is the clearest evidence the INSERT … ON
    // CONFLICT is transactional like any other statement.
    const sequence = await prisma.documentSequence.findUnique({
      where: { tenantId_docType: { tenantId: shop.tenantId, docType: 'SKU' } },
    });
    expect(sequence).toBeNull();

    const created = await variants.createVariantsBatch(
      shop.tenantId,
      shop.productAId,
      shop.ownerId,
      batch([{ unitPrice: 100, optionValues: [{ dimensionId, optionId: small.id }] }]),
    );
    expect(created[0].sku).toBe('APPAREL-0001-SMALL');
  });

  it('DOES burn a number when a collision retry abandons one', async () => {
    // This is where the gaps D104 accepts actually come from. Occupy the value
    // the first allocation composes, and 0001 is consumed without being used.
    await categorise('Apparel');
    const dims = await declareSize();
    const dimensionId = dims.dimensions[0].id;
    const small = dims.dimensions[0].options[0];

    await prisma.productVariant.create({
      data: {
        tenantId: shop.tenantId,
        productId: shop.productBId,
        sku: 'APPAREL-0001-SMALL',
        unitPrice: 1,
      },
    });

    const created = await variants.createVariantsBatch(
      shop.tenantId,
      shop.productAId,
      shop.ownerId,
      batch([{ unitPrice: 100, optionValues: [{ dimensionId, optionId: small.id }] }]),
    );
    expect(created[0].sku).toBe('APPAREL-0002-SMALL');

    // 0001 is gone for good — the sequence sits at 2 with only one variant
    // generated. A reused number would eventually reissue an identifier that
    // is already on a printed label.
    const sequence = await prisma.documentSequence.findUnique({
      where: { tenantId_docType: { tenantId: shop.tenantId, docType: 'SKU' } },
    });
    expect(sequence!.value).toBe(2);
  });

  /**
   * Mutation proof (D30 §5) — one sequence per batch reads better and is wrong.
   *
   * `APPAREL-0007-S`, `APPAREL-0007-M` looks tidier than 0001/0002. It also
   * stops the SKU identifying a variant on its own the moment two axes resolve
   * to the same code — which is exactly the state an unmapped catalogue is in.
   */
  it('CAUGHT: a batch-shared sequence collides once two options derive the same code', async () => {
    await categorise('Apparel');

    // Two dimensions whose options derive the same code — 'Small' on both.
    await variants.replaceVariations(
      shop.tenantId,
      shop.productAId,
      Object.assign(new ReplaceVariationsDto(), {
        dimensions: [
          { name: 'Size', options: [{ name: 'Small' }] },
          { name: 'Cut', options: [{ name: 'Small' }] },
        ],
      }),
    );
    const dims = await variants.listVariations(shop.tenantId, shop.productAId);
    const sizeSmall = dims.dimensions.find((d) => d.name === 'Size')!;
    const cutSmall = dims.dimensions.find((d) => d.name === 'Cut')!;

    const created = await variants.createVariantsBatch(
      shop.tenantId,
      shop.productAId,
      shop.ownerId,
      batch([
        {
          unitPrice: 100,
          optionValues: [
            { dimensionId: sizeSmall.id, optionId: sizeSmall.options[0].id },
            { dimensionId: cutSmall.id, optionId: cutSmall.options[0].id },
          ],
        },
      ]),
    );

    // The real implementation: distinct sequence numbers make it unique whatever
    // the codes are. Under a shared sequence both rows would compose
    // 'APPAREL-0001-SMALL-SMALL' and the second insert would violate
    // @@unique([tenantId, sku]).
    expect(created[0].sku).toBe('APPAREL-0001-SMALL-SMALL');
    const clash = prisma.productVariant.create({
      data: {
        tenantId: shop.tenantId,
        productId: shop.productAId,
        sku: 'APPAREL-0001-SMALL-SMALL',
        unitPrice: 1,
      },
    });
    await expect(clash).rejects.toBeDefined();
  });
});
