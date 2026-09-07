/**
 * Phase 8 retail reporting — `8.3` sales by variant, `8.4` tax by rate.
 *
 * ## What can only be proven here
 *
 *  • That money read back from `Decimal` columns survives to the response as an
 *    exact string. A mocked client would hand back JavaScript numbers and prove
 *    nothing about the thing A8 is about.
 *  • That the date window really excludes a sale one millisecond outside it.
 *  • That a DRAFT sale is not counted, which is a real WHERE clause.
 *  • **That a sale written by the real `SalesService` reports its tax.** This is
 *    the assertion the first cut of `8.3` did not have, and the reason it
 *    shipped a tax column that read `0.00` for every genuine sale:
 *    `SaleItem.taxAmount` is written as zero on purpose (D101) and the report
 *    summed it. A hand-written fixture hid that; driving the real service is
 *    what exposes it.
 *
 * ## What makes these assertions non-vacuous (D30)
 *
 * Every figure is an EXACT amount, and the two variants of one product are
 * asserted as separate rows with different quantities — an implementation that
 * grouped by product alone would produce one row of 5 and pass any assertion
 * phrased as "the total is right". The out-of-range and draft sales are seeded
 * with values that would visibly change the totals if they leaked in, so their
 * exclusion is proven rather than assumed. The tax splits use rates whose
 * weighted answer differs from the naive one (180/80, never 130/130).
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
import { SettingsService } from '../../../src/modules/settings/settings.service';
import { RetailReportsService } from '../../../src/modules/sales/retail-reports.service';

import { connectTestPrisma, disconnectTestPrisma } from '../prisma-test-client';
import { resetDatabase } from '../db-reset';
import { seedTileShopWithQuickBooks, type SeededTenant } from '../fixtures';

let prisma: PrismaClient;
let testModule: TestingModule;
let reports: RetailReportsService;
let sales: SalesService;
let settings: SettingsService;
let shop: SeededTenant;
let owner: { id: string; tenantId: string; role: string; activeBranchId: string | null };
let mediumId: string;
let largeId: string;

const RANGE = {
  from: new Date('2026-03-01T00:00:00.000Z'),
  to: new Date('2026-03-31T23:59:59.999Z'),
};

/** Wide enough to contain a sale completed by the clock, right now. */
const TODAY = {
  from: new Date(Date.now() - 60 * 60 * 1000),
  to: new Date(Date.now() + 60 * 60 * 1000),
};

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
  sales = testModule.get(SalesService);
  settings = testModule.get(SettingsService);
});

afterAll(async () => {
  /*
   * Leave NO global state behind — the same hazard `per-line-tax-snapshot`
   * documents at length. One test here sets a non-zero tax rate, `SettingsService`
   * caches it in memory keyed by the deterministic fixture id `tile-tenant`, and
   * a later suite boots its app BEFORE its first `resetDatabase`. Truncating
   * removes the row rather than trusting a later reader to interpret it.
   */
  await resetDatabase(prisma);
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
  owner = { id: shop.ownerId, tenantId: shop.tenantId, role: 'OWNER', activeBranchId: null };
  // The settings cache survives `resetDatabase`, so every test starts from an
  // explicit, known rate rather than whatever the previous one left.
  await settings.updateSettings(shop.tenantId, { taxRatePercent: 0 });

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
      { tenantId: shop.tenantId, variantId: medium.id, dimensionId: dimension.id, optionId: mOpt.id },
      { tenantId: shop.tenantId, variantId: large.id, dimensionId: dimension.id, optionId: lOpt.id },
    ],
  });
  mediumId = medium.id;
  largeId = large.id;

  // Stock for the one test that sells through the real service. LOCAL mode
  // depletes `BranchInventory` per variant, so a variant with no row is out of
  // stock and the sale is refused before any tax is computed.
  await prisma.branchInventory.createMany({
    data: [
      {
        tenantId: shop.tenantId,
        branchId: shop.branchId,
        productId: shop.productAId,
        productVariantId: medium.id,
        quantityOnHand: 50,
      },
      {
        tenantId: shop.tenantId,
        branchId: shop.branchId,
        productId: shop.productAId,
        productVariantId: large.id,
        quantityOnHand: 50,
      },
    ],
  });
});

interface FixtureLine {
  variantId: string | null;
  quantity: number;
  lineTotal: number;
  /** The rate FROZEN on the line (D101). `null` marks a pre-3.8 line. */
  rate: number | null;
  discount?: number;
  promotion?: number;
}

/**
 * A completed sale written directly.
 *
 * Deliberately not through `SalesService` for the grouping and windowing cases:
 * those are about the REPORT, and driving the whole sale pipeline would make the
 * expected figures a function of pricing, tax and promotion rules that have
 * their own specs.
 *
 * It writes the sale the way production writes it, which is the part that
 * matters: **`SaleItem.taxAmount` stays 0** and the tax lives on `Sale.taxAmount`
 * with a rate frozen per line. A fixture that put tax on the line would let a
 * report pass that reads `0.00` against every real sale — which is exactly what
 * happened.
 */
async function completedSale(
  completedAt: Date,
  lines: FixtureLine[],
  opts: { status?: 'COMPLETED' | 'DRAFT'; tax?: number; orderDiscount?: number } = {},
): Promise<void> {
  const status = opts.status ?? 'COMPLETED';
  const given = (l: FixtureLine) => (l.discount ?? 0) + (l.promotion ?? 0);
  const subtotal = lines.reduce((a, l) => a + l.lineTotal + given(l), 0);
  const totalDiscount = lines.reduce((a, l) => a + given(l), 0);
  const sale = await prisma.sale.create({
    data: {
      tenantId: shop.tenantId,
      branchId: shop.branchId,
      cashierId: shop.ownerId,
      saleNumber: `S-${Math.random().toString(36).slice(2, 10)}`,
      status,
      completedAt: status === 'COMPLETED' ? completedAt : null,
      subtotal,
      totalDiscount,
      orderDiscountAmount: opts.orderDiscount ?? 0,
      taxAmount: opts.tax ?? 0,
      total: subtotal - totalDiscount - (opts.orderDiscount ?? 0) + (opts.tax ?? 0),
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
        lineSubtotal: l.lineTotal + given(l),
        lineTotal: l.lineTotal,
        // Zero, like production. The rate is what the line records.
        taxAmount: 0,
        taxRatePercent: l.rate,
        discountAmount: l.discount ?? 0,
        promotionDiscountAmount: l.promotion ?? 0,
      },
    });
  }
}

describe('8.3 — sales by variant', () => {
  it('reports each size as its own row, with exact quantities and money', async () => {
    await completedSale(
      new Date('2026-03-10T10:00:00.000Z'),
      [
        { variantId: mediumId, quantity: 3, lineTotal: 3000, rate: 18, discount: 100 },
        { variantId: largeId, quantity: 2, lineTotal: 3000, rate: 18, promotion: 250 },
      ],
      { tax: 1080 },
    );

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
      // Equal taxable amounts at one rate: half the sale's 1080.
      tax: '540.00',
      discount: '100.00',
    });
    expect(report.rows[1]!.variantName).toBe('Large');
    expect(report.rows[1]!.quantitySold).toBe('2.000');
    expect(report.rows[1]!.tax).toBe('540.00');
    // Line discount and allocated promotion are one column: both are money the
    // shop gave away on that line.
    expect(report.rows[1]!.discount).toBe('250.00');

    expect(report.totals).toEqual({
      quantitySold: '5.000',
      revenue: '6000.00',
      tax: '1080.00',
      discount: '350.00',
    });
  });

  it('reports the tax of a sale the real SalesService completed', async () => {
    // The regression test for the defect this report shipped with. Nothing here
    // writes tax by hand: the settings say 18%, `SalesService.complete` does the
    // arithmetic, and it stores it where production stores it.
    await settings.updateSettings(shop.tenantId, { taxRatePercent: 18 });

    const sale = await sales.complete(shop.tenantId, owner as never, {
      branchId: shop.branchId,
      registerId: shop.registerId,
      items: [{ productId: shop.productAId, productVariantId: mediumId, quantity: 2 }],
      payments: [{ method: 'CASH', amount: 2360 }],
    } as never);

    // POSITIVE CONTROL, stated against the database rather than the report: the
    // sale really does carry tax, and its LINE really does carry zero. Without
    // this the assertion below could pass on a sale that was never taxed.
    expect(Number(sale.taxAmount)).toBe(360);
    const items = await prisma.saleItem.findMany({ where: { saleId: sale.id } });
    expect(items.map((i) => Number(i.taxAmount))).toEqual([0]);
    expect(items.map((i) => Number(i.taxRatePercent))).toEqual([18]);
    expect(items.map((i) => i.productVariantId)).toEqual([mediumId]);

    const report = await reports.salesByVariant(shop.tenantId, TODAY);
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]!.revenue).toBe('2000.00');
    // The whole point: NOT '0.00'.
    expect(report.rows[0]!.tax).toBe('360.00');
    expect(report.totals.tax).toBe('360.00');
  });

  it('sums the same variant across several sales', async () => {
    await completedSale(
      new Date('2026-03-02T09:00:00.000Z'),
      [{ variantId: mediumId, quantity: 1, lineTotal: 1000, rate: 18 }],
      { tax: 180 },
    );
    await completedSale(
      new Date('2026-03-20T09:00:00.000Z'),
      [{ variantId: mediumId, quantity: 4, lineTotal: 4000, rate: 18 }],
      { tax: 720 },
    );

    const report = await reports.salesByVariant(shop.tenantId, RANGE);
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]!.quantitySold).toBe('5.000');
    expect(report.rows[0]!.revenue).toBe('5000.00');
    expect(report.rows[0]!.tax).toBe('900.00');
  });

  it('excludes a sale one millisecond outside the window, at both ends', async () => {
    await completedSale(new Date('2026-02-28T23:59:59.999Z'), [
      { variantId: mediumId, quantity: 7, lineTotal: 7000, rate: 0 },
    ]);
    await completedSale(new Date('2026-04-01T00:00:00.000Z'), [
      { variantId: mediumId, quantity: 9, lineTotal: 9000, rate: 0 },
    ]);
    // Exactly on each boundary — these must be INCLUDED.
    await completedSale(RANGE.from, [
      { variantId: mediumId, quantity: 1, lineTotal: 1000, rate: 0 },
    ]);
    await completedSale(RANGE.to, [{ variantId: mediumId, quantity: 2, lineTotal: 2000, rate: 0 }]);

    const report = await reports.salesByVariant(shop.tenantId, RANGE);
    // 1 + 2 only. The excluded quantities are 7 and 9, so a leak in either
    // direction changes this number visibly rather than subtly.
    expect(report.totals.quantitySold).toBe('3.000');
    expect(report.totals.revenue).toBe('3000.00');
  });

  it('ignores a DRAFT sale — a held basket is not a sale', async () => {
    await completedSale(
      new Date('2026-03-10T10:00:00.000Z'),
      [{ variantId: mediumId, quantity: 6, lineTotal: 6000, rate: 0 }],
      { status: 'DRAFT' },
    );
    await completedSale(new Date('2026-03-11T10:00:00.000Z'), [
      { variantId: mediumId, quantity: 1, lineTotal: 1000, rate: 0 },
    ]);

    const report = await reports.salesByVariant(shop.tenantId, RANGE);
    expect(report.totals.quantitySold).toBe('1.000');
  });

  it('handles a product with no variant at all', async () => {
    await completedSale(new Date('2026-03-05T10:00:00.000Z'), [
      { variantId: null, quantity: 2, lineTotal: 2000, rate: 0 },
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
      { variantId: mediumId, quantity: 3, lineTotal: 3000, rate: 0 },
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

describe('8.4 — tax by rate', () => {
  it('splits one sale across the rates its lines were charged at', async () => {
    // 1000 at 18% and 1000 at 8%, tax 260. The split is by taxable × rate, so
    // 180/80 — an implementation weighting by amount alone would say 130/130.
    await completedSale(
      new Date('2026-03-10T10:00:00.000Z'),
      [
        { variantId: mediumId, quantity: 1, lineTotal: 1000, rate: 18 },
        { variantId: largeId, quantity: 1, lineTotal: 1000, rate: 8 },
      ],
      { tax: 260 },
    );

    const report = await reports.taxByRate(shop.tenantId, RANGE);

    expect(report.rows).toEqual([
      { ratePercent: '18.00', rateLabel: '18%', taxable: '1000.00', tax: '180.00' },
      { ratePercent: '8.00', rateLabel: '8%', taxable: '1000.00', tax: '80.00' },
    ]);
    expect(report.totals).toEqual({ taxable: '2000.00', tax: '260.00' });
    expect(report.hasUnattributed).toBe(false);
  });

  it('adds the same rate up across sales, and ties to what was charged', async () => {
    await completedSale(
      new Date('2026-03-02T09:00:00.000Z'),
      [{ variantId: mediumId, quantity: 1, lineTotal: 1000, rate: 18 }],
      { tax: 180 },
    );
    await completedSale(
      new Date('2026-03-09T09:00:00.000Z'),
      [{ variantId: mediumId, quantity: 1, lineTotal: 333.33, rate: 18 }],
      { tax: 60 },
    );
    await completedSale(
      new Date('2026-03-19T09:00:00.000Z'),
      [{ variantId: largeId, quantity: 1, lineTotal: 500, rate: 8 }],
      { tax: 40 },
    );

    const report = await reports.taxByRate(shop.tenantId, RANGE);

    expect(report.rows.map((r) => [r.rateLabel, r.taxable, r.tax])).toEqual([
      ['18%', '1333.33', '240.00'],
      ['8%', '500.00', '40.00'],
    ]);
    // The report must equal the tax the sales recorded: 180 + 60 + 40.
    expect(report.totals.tax).toBe('280.00');
  });

  it('shows a zero-rated row when there is one, rather than hiding it', async () => {
    // Proving an item was zero-rated is often a legal requirement, and it is
    // the line a shopper looks for when a price seems wrong.
    await completedSale(
      new Date('2026-03-10T10:00:00.000Z'),
      [
        { variantId: mediumId, quantity: 1, lineTotal: 1000, rate: 18 },
        { variantId: largeId, quantity: 1, lineTotal: 400, rate: 0 },
      ],
      { tax: 180 },
    );

    const report = await reports.taxByRate(shop.tenantId, RANGE);
    expect(report.rows).toEqual([
      { ratePercent: '18.00', rateLabel: '18%', taxable: '1000.00', tax: '180.00' },
      { ratePercent: '0.00', rateLabel: '0%', taxable: '400.00', tax: '0.00' },
    ]);
  });

  it('reports a single-rate shop, which the printed document deliberately does not', async () => {
    // A receipt prints no breakdown here — it would repeat the total it already
    // printed. A tax return needs exactly this row.
    await completedSale(
      new Date('2026-03-10T10:00:00.000Z'),
      [
        { variantId: mediumId, quantity: 1, lineTotal: 1000, rate: 18 },
        { variantId: largeId, quantity: 1, lineTotal: 500, rate: 18 },
      ],
      { tax: 270 },
    );

    const report = await reports.taxByRate(shop.tenantId, RANGE);
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]).toEqual({
      ratePercent: '18.00',
      rateLabel: '18%',
      taxable: '1500.00',
      tax: '270.00',
    });
  });

  it('takes the order discount out of the taxable base', async () => {
    await completedSale(
      new Date('2026-03-10T10:00:00.000Z'),
      [{ variantId: mediumId, quantity: 1, lineTotal: 1000, rate: 18 }],
      { tax: 162, orderDiscount: 100 },
    );

    const report = await reports.taxByRate(shop.tenantId, RANGE);
    // 1000 less the 100 order discount, not 1000.
    expect(report.rows[0]!.taxable).toBe('900.00');
    expect(report.rows[0]!.tax).toBe('162.00');
  });

  it('says so when a sale predates per-line rates, instead of guessing', async () => {
    await completedSale(
      new Date('2026-03-04T10:00:00.000Z'),
      [{ variantId: mediumId, quantity: 1, lineTotal: 1000, rate: null }],
      { tax: 180 },
    );
    await completedSale(
      new Date('2026-03-05T10:00:00.000Z'),
      [{ variantId: mediumId, quantity: 1, lineTotal: 2000, rate: 18 }],
      { tax: 360 },
    );

    const report = await reports.taxByRate(shop.tenantId, RANGE);

    expect(report.hasUnattributed).toBe(true);
    // The unattributed row is last and names itself. Its tax is the old sale's
    // own 180 — real money, in a row that admits it cannot say which rate.
    expect(report.rows).toEqual([
      { ratePercent: '18.00', rateLabel: '18%', taxable: '2000.00', tax: '360.00' },
      { ratePercent: null, rateLabel: 'Rate not recorded', taxable: '1000.00', tax: '180.00' },
    ]);
    // NEGATIVE: the 180 was not folded into the 18% row, which is the mistake
    // this row exists to prevent.
    expect(report.rows[0]!.tax).not.toBe('540.00');
    expect(report.totals.tax).toBe('540.00');
  });

  it('returns zeroes for an empty period, and refuses a reversed range', async () => {
    const report = await reports.taxByRate(shop.tenantId, RANGE);
    expect(report.rows).toEqual([]);
    expect(report.totals).toEqual({ taxable: '0.00', tax: '0.00' });
    expect(report.hasUnattributed).toBe(false);

    await expect(
      reports.taxByRate(shop.tenantId, { from: RANGE.to, to: RANGE.from }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('agrees with 8.3: the same sales, the same total tax', async () => {
    // Two reports over one range must not disagree about how much tax was
    // charged. They fold the same allocation differently, so this is a real
    // cross-check rather than a restatement.
    await completedSale(
      new Date('2026-03-10T10:00:00.000Z'),
      [
        { variantId: mediumId, quantity: 2, lineTotal: 2000, rate: 18 },
        { variantId: largeId, quantity: 1, lineTotal: 750, rate: 8 },
      ],
      { tax: 420 },
    );

    const [byVariant, byRate] = await Promise.all([
      reports.salesByVariant(shop.tenantId, RANGE),
      reports.taxByRate(shop.tenantId, RANGE),
    ]);
    expect(byVariant.totals.tax).toBe(byRate.totals.tax);
    expect(byRate.totals.tax).toBe('420.00');
  });
});
