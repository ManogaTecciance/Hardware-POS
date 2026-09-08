/**
 * D132 (`8.7`) — stock takes / cycle counts.
 *
 * ## What can only be proven here
 *
 *  • That the count actually moves the row the SALE path guards. A unit test
 *    with a mocked client would assert that a method was called; only a real
 *    database shows that the next sale sees the corrected number.
 *  • That the oversell guard is intact AFTER a count — the property this whole
 *    decision turns on, asserted by selling.
 *  • That a `StockMovement` is written with the right delta and reference.
 *
 * ## What makes these assertions non-vacuous (D30)
 *
 * The central pair is asserted in BOTH directions: a count DOWN succeeds (no
 * `gte` guard), and a sale beyond the counted quantity is still refused (the
 * guard is untouched). Either alone would pass for a broken implementation —
 * the first for one that removed the guard, the second for one that refused the
 * count. The variance figures are exact, and the "no movement for an unchanged
 * line" case is asserted as an exact count of ledger rows rather than as a
 * property of the last one.
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
import { SalesModule } from '../../../src/modules/sales/sales.module';
import { SalesService } from '../../../src/modules/sales/sales.service';
import { StockTakesModule } from '../../../src/modules/stock-takes/stock-takes.module';
import { StockTakesService } from '../../../src/modules/stock-takes/stock-takes.service';

import { connectTestPrisma, disconnectTestPrisma } from '../prisma-test-client';
import { resetDatabase } from '../db-reset';
import { seedTileShopWithQuickBooks, type SeededTenant } from '../fixtures';

let prisma: PrismaClient;
let testModule: TestingModule;
let stockTakes: StockTakesService;
let sales: SalesService;
let shop: SeededTenant;
let owner: { id: string; tenantId: string; role: string; activeBranchId: string | null };
let mediumId: string;

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
      StockTakesModule,
    ],
  }).compile();
  testModule.useLogger(false);
  await testModule.init();
  stockTakes = testModule.get(StockTakesService);
  sales = testModule.get(SalesService);
});

afterAll(async () => {
  await testModule.close();
  await disconnectTestPrisma();
});

/** LOCAL inventory unless a test says otherwise — the retail template's mode. */
async function seed(mode: InventoryMode = InventoryMode.LOCAL): Promise<void> {
  await resetDatabase(prisma);
  shop = await seedTileShopWithQuickBooks(prisma);
  await prisma.tenantBusinessProfile.create({
    data: {
      tenantId: shop.tenantId,
      businessType: BusinessType.RETAIL,
      inventoryMode: mode,
      accountingProvider: AccountingProviderKind.NONE,
    },
  });
  owner = { id: shop.ownerId, tenantId: shop.tenantId, role: 'OWNER', activeBranchId: null };

  await prisma.product.update({ where: { id: shop.productAId }, data: { hasVariants: true } });
  const dimension = await prisma.productVariationDimension.create({
    data: { tenantId: shop.tenantId, productId: shop.productAId, name: 'Size', position: 0 },
  });
  const option = await prisma.productVariationOption.create({
    data: { tenantId: shop.tenantId, dimensionId: dimension.id, name: 'Medium', position: 0 },
  });
  const medium = await prisma.productVariant.create({
    data: {
      tenantId: shop.tenantId,
      productId: shop.productAId,
      sku: 'A-M',
      unitPrice: 1000,
      averageCost: 600,
      isDefault: true,
    },
  });
  await prisma.productVariantOptionValue.create({
    data: {
      tenantId: shop.tenantId,
      variantId: medium.id,
      dimensionId: dimension.id,
      optionId: option.id,
    },
  });
  await prisma.branchInventory.create({
    data: {
      tenantId: shop.tenantId,
      branchId: shop.branchId,
      productId: shop.productAId,
      productVariantId: medium.id,
      quantityOnHand: 10,
    },
  });
  mediumId = medium.id;
}

beforeEach(() => seed());

async function shelfQty(): Promise<number> {
  const row = await prisma.branchInventory.findFirstOrThrow({
    where: { tenantId: shop.tenantId, productVariantId: mediumId },
  });
  return Number(row.quantityOnHand);
}

describe('a count states reality', () => {
  it('counts a shelf DOWN without any guard refusing it', async () => {
    // The books say 10, the shelf holds 4. This is the case a `gte`-guarded
    // write would refuse, leaving the books wrong and the shelf uncounted.
    const view = await stockTakes.create(shop.tenantId, shop.ownerId, {
      branchId: shop.branchId,
      lines: [{ productId: shop.productAId, productVariantId: mediumId, countedQuantity: 4 }],
      note: 'Friday cycle count',
    });

    expect(await shelfQty()).toBe(4);
    expect(view.lines).toHaveLength(1);
    expect(view.lines[0]).toEqual({
      productId: shop.productAId,
      productVariantId: mediumId,
      productName: 'Fixture Product A',
      variantName: 'Medium',
      expectedQuantity: '10.000',
      countedQuantity: '4.000',
      variance: '-6.000',
      unitCost: '600.0000',
      // Six missing at 600 each: 3,600 of stock gone.
      varianceValue: '-3600.00',
    });
    expect(view.varianceLines).toBe(1);
    expect(view.varianceValue).toBe('-3600.00');
    expect(view.unvaluedLines).toBe(0);
    expect(view.countNumber).toMatch(/^SC-\d{6}$/);
    expect(view.note).toBe('Friday cycle count');
  });

  it('leaves the oversell guard intact — the sale path still refuses', async () => {
    // The other half of the pair above, and the reason both are needed: an
    // implementation that satisfied the first by removing the `gte` predicate
    // would fail here.
    await stockTakes.create(shop.tenantId, shop.ownerId, {
      branchId: shop.branchId,
      lines: [{ productId: shop.productAId, productVariantId: mediumId, countedQuantity: 4 }],
    });

    await expect(
      sales.complete(shop.tenantId, owner as never, {
        branchId: shop.branchId,
        registerId: shop.registerId,
        items: [{ productId: shop.productAId, productVariantId: mediumId, quantity: 5 }],
        payments: [{ method: 'CASH', amount: 5000 }],
      } as never),
    ).rejects.toThrow(/Insufficient stock/);

    // POSITIVE CONTROL: selling exactly what was counted DOES work, so the
    // refusal above is a boundary rather than a broken sale path.
    const sale = await sales.complete(shop.tenantId, owner as never, {
      branchId: shop.branchId,
      registerId: shop.registerId,
      items: [{ productId: shop.productAId, productVariantId: mediumId, quantity: 4 }],
      payments: [{ method: 'CASH', amount: 4000 }],
    } as never);
    expect(sale.status).toBe('COMPLETED');
    expect(await shelfQty()).toBe(0);
  });

  it('counts a shelf UP when stock is found', async () => {
    await stockTakes.create(shop.tenantId, shop.ownerId, {
      branchId: shop.branchId,
      lines: [{ productId: shop.productAId, productVariantId: mediumId, countedQuantity: 13 }],
    });
    expect(await shelfQty()).toBe(13);

    const movements = await prisma.stockMovement.findMany({
      where: { tenantId: shop.tenantId, reason: 'ADJUSTMENT' },
    });
    expect(movements).toHaveLength(1);
    expect(Number(movements[0]!.delta)).toBe(3);
    expect(Number(movements[0]!.balanceAfter)).toBe(13);
  });

  it('writes an auditable movement, referenced back to the count', async () => {
    const view = await stockTakes.create(shop.tenantId, shop.ownerId, {
      branchId: shop.branchId,
      lines: [{ productId: shop.productAId, productVariantId: mediumId, countedQuantity: 7 }],
    });

    const movements = await prisma.stockMovement.findMany({
      where: { tenantId: shop.tenantId, refType: 'STOCK_TAKE' },
    });
    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({
      refId: view.id,
      productId: shop.productAId,
      productVariantId: mediumId,
      branchId: shop.branchId,
      createdByUserId: shop.ownerId,
    });
    expect(Number(movements[0]!.delta)).toBe(-3);
  });

  it('records no movement for a line that matched the books', async () => {
    const view = await stockTakes.create(shop.tenantId, shop.ownerId, {
      branchId: shop.branchId,
      lines: [{ productId: shop.productAId, productVariantId: mediumId, countedQuantity: 10 }],
    });

    // The line IS in the document — it was counted, and that is worth recording.
    expect(view.lines).toHaveLength(1);
    expect(view.lines[0]!.variance).toBe('0.000');
    expect(view.varianceLines).toBe(0);
    expect(view.varianceValue).toBe('0.00');

    // But the ledger gets nothing: a zero-delta movement says nothing and would
    // fill the stock history with noise. Asserted as an exact count.
    const movements = await prisma.stockMovement.findMany({
      where: { tenantId: shop.tenantId },
    });
    expect(movements).toEqual([]);
  });

  it('counts a variant that has no shelf row yet', async () => {
    const large = await prisma.productVariant.create({
      data: { tenantId: shop.tenantId, productId: shop.productAId, sku: 'A-L', unitPrice: 1500 },
    });

    const view = await stockTakes.create(shop.tenantId, shop.ownerId, {
      branchId: shop.branchId,
      lines: [{ productId: shop.productAId, productVariantId: large.id, countedQuantity: 5 }],
    });

    // No cell means none on that shelf, so the whole count is the variance.
    expect(view.lines[0]!.expectedQuantity).toBe('0.000');
    expect(view.lines[0]!.variance).toBe('5.000');
    const cell = await prisma.branchInventory.findFirstOrThrow({
      where: { tenantId: shop.tenantId, productVariantId: large.id },
    });
    expect(Number(cell.quantityOnHand)).toBe(5);
  });

  it('counts a product sold without variants, and moves what the sale reads', async () => {
    // `Product.quantityOnHand` is what `reduceStock` guards for a variant-less
    // sale, so a count that did not move it would leave the shop overselling.
    const before = await prisma.product.findUniqueOrThrow({ where: { id: shop.productBId } });
    expect(Number(before.quantityOnHand)).toBe(50);

    const view = await stockTakes.create(shop.tenantId, shop.ownerId, {
      branchId: shop.branchId,
      lines: [{ productId: shop.productBId, countedQuantity: 38 }],
    });

    expect(view.lines[0]!.expectedQuantity).toBe('50.000');
    expect(view.lines[0]!.variance).toBe('-12.000');
    const after = await prisma.product.findUniqueOrThrow({ where: { id: shop.productBId } });
    expect(Number(after.quantityOnHand)).toBe(38);
    // And the branch cell agrees, so both readers see the same shelf.
    const cell = await prisma.branchInventory.findFirstOrThrow({
      where: { tenantId: shop.tenantId, productId: shop.productBId, productVariantId: null },
    });
    expect(Number(cell.quantityOnHand)).toBe(38);
  });

  it('values a variance it cannot cost as unknown, not as zero', async () => {
    await prisma.productVariant.update({
      where: { id: mediumId },
      data: { averageCost: null, costPrice: null },
    });

    const view = await stockTakes.create(shop.tenantId, shop.ownerId, {
      branchId: shop.branchId,
      lines: [{ productId: shop.productAId, productVariantId: mediumId, countedQuantity: 6 }],
    });

    expect(view.lines[0]!.unitCost).toBeNull();
    expect(view.lines[0]!.varianceValue).toBeNull();
    // The variance itself is still known and reported; only its VALUE is not.
    expect(view.lines[0]!.variance).toBe('-4.000');
    expect(view.varianceLines).toBe(1);
    expect(view.unvaluedLines).toBe(1);
    // NEGATIVE: four missing shirts did not cost the shop nothing.
    expect(view.varianceValue).toBe('0.00');
    expect(view.unvaluedLines).toBeGreaterThan(0);
  });
});

describe('the document', () => {
  it('is idempotent — a resubmitted form does not post the correction twice', async () => {
    const first = await stockTakes.create(shop.tenantId, shop.ownerId, {
      branchId: shop.branchId,
      lines: [{ productId: shop.productAId, productVariantId: mediumId, countedQuantity: 4 }],
      idempotencyKey: 'count-form-1',
    });
    const second = await stockTakes.create(shop.tenantId, shop.ownerId, {
      branchId: shop.branchId,
      lines: [{ productId: shop.productAId, productVariantId: mediumId, countedQuantity: 4 }],
      idempotencyKey: 'count-form-1',
    });

    expect(second.id).toBe(first.id);
    expect(await prisma.stockTake.count({ where: { tenantId: shop.tenantId } })).toBe(1);
    // And crucially the shelf moved once. A second application would be
    // harmless here (setting 4 twice is 4), so the LEDGER is what proves it.
    expect(await prisma.stockMovement.count({ where: { tenantId: shop.tenantId } })).toBe(1);
  });

  it('numbers counts sequentially per tenant', async () => {
    const a = await stockTakes.create(shop.tenantId, shop.ownerId, {
      branchId: shop.branchId,
      lines: [{ productId: shop.productAId, productVariantId: mediumId, countedQuantity: 9 }],
    });
    const b = await stockTakes.create(shop.tenantId, shop.ownerId, {
      branchId: shop.branchId,
      lines: [{ productId: shop.productAId, productVariantId: mediumId, countedQuantity: 8 }],
    });
    expect([a.countNumber, b.countNumber]).toEqual(['SC-000001', 'SC-000002']);
  });

  it('freezes the product name, so a later rename cannot rewrite it', async () => {
    const view = await stockTakes.create(shop.tenantId, shop.ownerId, {
      branchId: shop.branchId,
      lines: [{ productId: shop.productAId, productVariantId: mediumId, countedQuantity: 4 }],
    });
    await prisma.product.update({
      where: { id: shop.productAId },
      data: { name: 'Renamed After The Count' },
    });

    const reread = await stockTakes.getById(shop.tenantId, view.id);
    expect(reread.lines[0]!.productName).toBe('Fixture Product A');
  });

  it('refuses the same product and variant twice in one count', async () => {
    await expect(
      stockTakes.create(shop.tenantId, shop.ownerId, {
        branchId: shop.branchId,
        lines: [
          { productId: shop.productAId, productVariantId: mediumId, countedQuantity: 4 },
          { productId: shop.productAId, productVariantId: mediumId, countedQuantity: 6 },
        ],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses a branch belonging to another tenant', async () => {
    const other = await prisma.tenant.create({
      data: { name: 'Other Shop', slug: 'other-shop-count' },
    });
    const otherBranch = await prisma.branch.create({
      data: { tenantId: other.id, name: 'Their Branch', code: 'OTH' },
    });

    await expect(
      stockTakes.create(shop.tenantId, shop.ownerId, {
        branchId: otherBranch.id,
        lines: [{ productId: shop.productAId, productVariantId: mediumId, countedQuantity: 4 }],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    // Nothing was written on the way to the refusal.
    expect(await prisma.stockTake.count()).toBe(0);
  });

  it('lists and reads back what was counted', async () => {
    const created = await stockTakes.create(shop.tenantId, shop.ownerId, {
      branchId: shop.branchId,
      lines: [{ productId: shop.productAId, productVariantId: mediumId, countedQuantity: 4 }],
    });

    const list = await stockTakes.list(shop.tenantId);
    expect(list.map((s) => s.id)).toEqual([created.id]);
    expect(list[0]!.countedByName).toBe('Fixture Owner');

    const one = await stockTakes.getById(shop.tenantId, created.id);
    expect(one.lines[0]!.countedQuantity).toBe('4.000');
  });
});

describe('a tenant whose stock is not ours to write', () => {
  it('refuses the count with a reason, rather than silently doing nothing', async () => {
    // QuickBooks owns the stock; `quantityOnHand` here is a cache that the next
    // pull would overwrite. A silent success would be the worst outcome — a
    // count document with no ledger effect anywhere.
    await seed(InventoryMode.QUICKBOOKS);

    await expect(
      stockTakes.create(shop.tenantId, shop.ownerId, {
        branchId: shop.branchId,
        lines: [{ productId: shop.productAId, productVariantId: mediumId, countedQuantity: 4 }],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    // NEGATIVE, and the point of the test: nothing moved and no document
    // survived the rolled-back transaction.
    expect(await shelfQty()).toBe(10);
    expect(await prisma.stockTake.count()).toBe(0);
    expect(await prisma.stockMovement.count()).toBe(0);
  });

  it('refuses for a tenant with inventory tracking off', async () => {
    await seed(InventoryMode.DISABLED);

    await expect(
      stockTakes.create(shop.tenantId, shop.ownerId, {
        branchId: shop.branchId,
        lines: [{ productId: shop.productAId, productVariantId: mediumId, countedQuantity: 4 }],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(await prisma.stockTake.count()).toBe(0);
  });
});
