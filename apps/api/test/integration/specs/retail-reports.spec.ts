/**
 * Phase 8 retail reporting — `8.3` sales by variant.
 *
 * ## What can only be proven here
 *
 *  • That `groupBy` with `_sum` over `Decimal` columns returns `Prisma.Decimal`
 *    and survives to the response as an exact string. A mocked client would hand
 *    back JavaScript numbers and prove nothing about the thing A8 is about.
 *  • That the date window really excludes a sale one millisecond outside it.
 *  • That a DRAFT sale is not counted, which is a real WHERE clause.
 *
 * ## What makes these assertions non-vacuous (D30)
 *
 * Every figure is an EXACT amount, and the two variants of one product are
 * asserted as separate rows with different quantities — an implementation that
 * grouped by product alone would produce one row of 5 and pass any assertion
 * phrased as "the total is right". The out-of-range and draft sales are seeded
 * with values that would visibly change the totals if they leaked in, so their
 * exclusion is proven rather than assumed.
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
import { RetailReportsService } from '../../../src/modules/sales/retail-reports.service';

import { connectTestPrisma, disconnectTestPrisma } from '../prisma-test-client';
import { resetDatabase } from '../db-reset';
import { seedTileShopWithQuickBooks, type SeededTenant } from '../fixtures';

let prisma: PrismaClient;
let testModule: TestingModule;
let reports: RetailReportsService;
let shop: SeededTenant;
let mediumId: string;
let largeId: string;

const RANGE = { from: new Date('2026-03-01T00:00:00.000Z'), to: new Date('2026-03-31T23:59:59.999Z') };

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
  reports = testModule.get(RetailReportsService);
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

  const dimension = await prisma.productVariationDimension.create({
    data: { tenantId: shop.tenantId, productId: shop.productAId, name: 'Size', position: 0 },
  });
  const [mOpt, lOpt] = await Promise.all([
    prisma.productVariationOption.create({
      data: { tenantId: shop.tenantId, dimensionId: dimension.id, name: 'Medium', position: 0 },
    }),
    prisma.productVariationOption.create({
      data: { tenantId: shop.tenantId, dimensionId: dimension.id, name: 'Large', position: 1 },
    }),
  ]);
  const medium = await prisma.productVariant.create({
    data: { tenantId: shop.tenantId, productId: shop.productAId, sku: 'A-M', unitPrice: 1000 },
  });
  const large = await prisma.productVariant.create({
    data: { tenantId: shop.tenantId, productId: shop.productAId, sku: 'A-L', unitPrice: 1500 },
  });
  await prisma.productVariantOptionValue.createMany({
    data: [
      {
        tenantId: shop.tenantId,
        variantId: medium.id,
        dimensionId: dimension.id,
        optionId: mOpt.id,
      },
      {
        tenantId: shop.tenantId,
        variantId: large.id,
        dimensionId: dimension.id,
        optionId: lOpt.id,
      },
    ],
  });
  mediumId = medium.id;
  largeId = large.id;
});

/**
 * A completed sale written directly.
 *
 * Deliberately not through `SalesService`: this spec is about the REPORT, and
 * driving the whole sale pipeline would make the expected figures a function of
 * pricing, tax and promotion rules that have their own specs. Written lines give
 * exact, obvious inputs.
 */
async function completedSale(
  completedAt: Date,
  lines: {
    variantId: string | null;
    quantity: number;
    lineTotal: number;
    tax: number;
    discount?: number;
    promotion?: number;
  }[],
  status: 'COMPLETED' | 'DRAFT' = 'COMPLETED',
): Promise<void> {
  const sale = await prisma.sale.create({
    data: {
      tenantId: shop.tenantId,
      branchId: shop.branchId,
      cashierId: shop.ownerId,
      saleNumber: `S-${Math.random().toString(36).slice(2, 10)}`,
      status,
      completedAt: status === 'COMPLETED' ? completedAt : null,
      subtotal: 0,
      total: 0,
    },
  });
  for (const l of lines) {
    await prisma.saleItem.create({
      data: {
        saleId: sale.id,
        productId: shop.productAId,
        productVariantId: l.variantId,
        productName: 'Fixture Product A',
        quantity: l.quantity,
        unitPrice: 1000,
        lineSubtotal: l.lineTotal,
        lineTotal: l.lineTotal,
        taxAmount: l.tax,
        discountAmount: l.discount ?? 0,
        promotionDiscountAmount: l.promotion ?? 0,
      },
    });
  }
}

describe('8.3 — sales by variant', () => {
  it('reports each size as its own row, with exact quantities and money', async () => {
    await completedSale(new Date('2026-03-10T10:00:00.000Z'), [
      { variantId: mediumId, quantity: 3, lineTotal: 3000, tax: 450, discount: 100 },
      { variantId: largeId, quantity: 2, lineTotal: 3000, tax: 450, promotion: 250 },
    ]);

    const report = await reports.salesByVariant(shop.tenantId, RANGE);

    // Two rows, best seller first. An implementation that grouped by product
    // alone would give one row of 5 and satisfy any total-only assertion.
    expect(report.rows).toHaveLength(2);
    expect(report.rows[0]).toEqual({
      productId: shop.productAId,
      productName: 'Fixture Product A',
      productVariantId: mediumId,
      variantName: 'Medium',
      sku: 'A-M',
      quantitySold: '3.000',
      revenue: '3000.00',
      tax: '450.00',
      discount: '100.00',
    });
    expect(report.rows[1]!.variantName).toBe('Large');
    expect(report.rows[1]!.quantitySold).toBe('2.000');
    // Line discount and allocated promotion are one column: both are money the
    // shop gave away on that line.
    expect(report.rows[1]!.discount).toBe('250.00');

    expect(report.totals).toEqual({
      quantitySold: '5.000',
      revenue: '6000.00',
      tax: '900.00',
      discount: '350.00',
    });
  });

  it('sums the same variant across several sales', async () => {
    await completedSale(new Date('2026-03-02T09:00:00.000Z'), [
      { variantId: mediumId, quantity: 1, lineTotal: 1000, tax: 150 },
    ]);
    await completedSale(new Date('2026-03-20T09:00:00.000Z'), [
      { variantId: mediumId, quantity: 4, lineTotal: 4000, tax: 600 },
    ]);

    const report = await reports.salesByVariant(shop.tenantId, RANGE);
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]!.quantitySold).toBe('5.000');
    expect(report.rows[0]!.revenue).toBe('5000.00');
    expect(report.rows[0]!.tax).toBe('750.00');
  });

  it('excludes a sale one millisecond outside the window, at both ends', async () => {
    await completedSale(new Date('2026-02-28T23:59:59.999Z'), [
      { variantId: mediumId, quantity: 7, lineTotal: 7000, tax: 0 },
    ]);
    await completedSale(new Date('2026-04-01T00:00:00.000Z'), [
      { variantId: mediumId, quantity: 9, lineTotal: 9000, tax: 0 },
    ]);
    // Exactly on each boundary — these must be INCLUDED.
    await completedSale(RANGE.from, [{ variantId: mediumId, quantity: 1, lineTotal: 1000, tax: 0 }]);
    await completedSale(RANGE.to, [{ variantId: mediumId, quantity: 2, lineTotal: 2000, tax: 0 }]);

    const report = await reports.salesByVariant(shop.tenantId, RANGE);
    // 1 + 2 only. The excluded quantities are 7 and 9, so a leak in either
    // direction changes this number visibly rather than subtly.
    expect(report.totals.quantitySold).toBe('3.000');
    expect(report.totals.revenue).toBe('3000.00');
  });

  it('ignores a DRAFT sale — a held basket is not a sale', async () => {
    await completedSale(
      new Date('2026-03-10T10:00:00.000Z'),
      [{ variantId: mediumId, quantity: 6, lineTotal: 6000, tax: 0 }],
      'DRAFT',
    );
    await completedSale(new Date('2026-03-11T10:00:00.000Z'), [
      { variantId: mediumId, quantity: 1, lineTotal: 1000, tax: 0 },
    ]);

    const report = await reports.salesByVariant(shop.tenantId, RANGE);
    expect(report.totals.quantitySold).toBe('1.000');
  });

  it('handles a product with no variant at all', async () => {
    await completedSale(new Date('2026-03-05T10:00:00.000Z'), [
      { variantId: null, quantity: 2, lineTotal: 2000, tax: 0 },
    ]);

    const report = await reports.salesByVariant(shop.tenantId, RANGE);
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]!.productVariantId).toBeNull();
    expect(report.rows[0]!.variantName).toBeNull();
    // Falls back to the product's own SKU rather than showing nothing.
    expect(report.rows[0]!.sku).toBe('tile-SKU-A');
  });

  it('is scoped to the tenant', async () => {
    await completedSale(new Date('2026-03-10T10:00:00.000Z'), [
      { variantId: mediumId, quantity: 3, lineTotal: 3000, tax: 0 },
    ]);
    const other = await reports.salesByVariant('some-other-tenant', RANGE);
    expect(other.rows).toEqual([]);
    expect(other.totals.revenue).toBe('0.00');
  });

  it('returns zeroes rather than nothing for an empty period', async () => {
    const report = await reports.salesByVariant(shop.tenantId, RANGE);
    expect(report.rows).toEqual([]);
    // A missing figure and a zero figure are different answers; a manager
    // reading "0.00" knows the query ran.
    expect(report.totals).toEqual({
      quantitySold: '0.000',
      revenue: '0.00',
      tax: '0.00',
      discount: '0.00',
    });
  });

  it('refuses a reversed range instead of silently swapping it', async () => {
    await expect(
      reports.salesByVariant(shop.tenantId, { from: RANGE.to, to: RANGE.from }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
