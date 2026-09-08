/**
 * Phase 8 retail reporting — `8.3` sales by variant, `8.4` tax by rate,
 * `8.5` margin, `8.6` ageing.
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
 *    `SaleItem.taxAmount` is written as zero on purpose (D122) and the report
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
  /** The rate FROZEN on the line (D122). `null` marks a pre-3.8 line. */
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
      // D133 (`8.9`) — null because this fixture product carries no brand.
      // Asserted rather than omitted: an exact-shape assertion is what
      // catches a field appearing, and `brandName` appearing is what 8.9
      // did to this row.
      brandName: null,
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

  it('names the brand a product carries, and null when it carries none', async () => {
    // D133 (`8.9`) — "reports by brand" is what the entity was for. Resolved
    // from the product as it stands today, like the product name beside it.
    const brand = await prisma.brand.create({
      data: { tenantId: shop.tenantId, name: 'Fixture Label' },
    });
    await prisma.product.update({
      where: { id: shop.productAId },
      data: { brandId: brand.id },
    });
    await completedSale(new Date('2026-03-10T10:00:00.000Z'), [
      { variantId: mediumId, quantity: 1, lineTotal: 1000, rate: 0 },
    ]);

    const branded = await reports.salesByVariant(shop.tenantId, RANGE);
    expect(branded.rows[0]!.brandName).toBe('Fixture Label');

    // NEGATIVE: unlink it and the same row reports null rather than a stale
    // name. Without this the assertion above would pass for a field that was
    // hard-coded or cached.
    await prisma.product.update({ where: { id: shop.productAId }, data: { brandId: null } });
    const unbranded = await reports.salesByVariant(shop.tenantId, RANGE);
    expect(unbranded.rows[0]!.brandName).toBeNull();
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

  it('takes the order discount off the line it belongs to', async () => {
    // Revenue is what the shop RECEIVED. A 200 discount on a 2000 basket is
    // money nobody paid, and it belongs to no single line, so each 1000 line
    // carries 100 of it. Reporting 1000 here would overstate every row in
    // every report that shares this definition — `8.5` costs its margin
    // against exactly this figure.
    await completedSale(
      new Date('2026-03-10T10:00:00.000Z'),
      [
        { variantId: mediumId, quantity: 1, lineTotal: 1000, rate: 18 },
        { variantId: largeId, quantity: 1, lineTotal: 1000, rate: 18 },
      ],
      { tax: 324, orderDiscount: 200 },
    );

    const report = await reports.salesByVariant(shop.tenantId, RANGE);
    expect(report.rows.map((r) => r.revenue)).toEqual(['900.00', '900.00']);
    expect(report.totals.revenue).toBe('1800.00');
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

/** Give a variant a weighted-average cost the way a goods receipt would. */
async function setVariantCost(
  variantId: string,
  averageCost: number | null,
  costPrice: number | null = null,
): Promise<void> {
  await prisma.productVariant.update({
    where: { id: variantId },
    data: { averageCost, costPrice },
  });
}

describe('8.5 — margin', () => {
  it('costs what sold at the variant average, and states which cost it used', async () => {
    await setVariantCost(mediumId, 600);
    await completedSale(new Date('2026-03-10T10:00:00.000Z'), [
      { variantId: mediumId, quantity: 3, lineTotal: 3000, rate: 0 },
    ]);

    const report = await reports.margin(shop.tenantId, RANGE);

    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]).toEqual({
      productId: shop.productAId,
      productName: 'Fixture Product A',
      productVariantId: mediumId,
      variantName: 'Medium',
      sku: 'A-M',
      quantitySold: '3.000',
      revenue: '3000.00',
      cost: '1800.00',
      margin: '1200.00',
      marginPercent: '40.00',
      costSource: 'VARIANT_AVERAGE',
    });
    expect(report.totals).toEqual({
      revenue: '3000.00',
      cost: '1800.00',
      margin: '1200.00',
      marginPercent: '40.00',
    });
    expect(report.unknownCost).toEqual({ rows: 0, revenue: '0.00' });
  });

  it('reports an unknown cost as unknown, never as a 100% margin', async () => {
    // The defect this assertion exists to prevent: a variant nothing has ever
    // been received against has `averageCost = NULL`. Costing it at zero would
    // report the whole sale as profit.
    await setVariantCost(mediumId, 600);
    await setVariantCost(largeId, null, null);
    await completedSale(new Date('2026-03-10T10:00:00.000Z'), [
      { variantId: mediumId, quantity: 1, lineTotal: 1000, rate: 0 },
      { variantId: largeId, quantity: 1, lineTotal: 1500, rate: 0 },
    ]);

    const report = await reports.margin(shop.tenantId, RANGE);

    const unknown = report.rows.find((r) => r.productVariantId === largeId)!;
    expect(unknown.cost).toBeNull();
    expect(unknown.margin).toBeNull();
    expect(unknown.marginPercent).toBeNull();
    expect(unknown.costSource).toBe('UNKNOWN');
    // Its revenue is still known, and reported — separately, so the reader can
    // see how much of the period the totals do NOT cover.
    expect(unknown.revenue).toBe('1500.00');
    expect(report.unknownCost).toEqual({ rows: 1, revenue: '1500.00' });

    // POSITIVE: the totals are over the KNOWN row only. 1000 - 600 = 400.
    expect(report.totals).toEqual({
      revenue: '1000.00',
      cost: '600.00',
      margin: '400.00',
      marginPercent: '40.00',
    });
    // NEGATIVE: the unknown row's 1500 did not leak into them, which is what a
    // zero-cost fallback would have done.
    expect(report.totals.revenue).not.toBe('2500.00');
    expect(report.totals.margin).not.toBe('1900.00');
  });

  it('falls back to the variant latest purchase, and to the product only without a variant', async () => {
    // No average, but a real purchase cost on the VARIANT: better than nothing,
    // and the row reports WHICH so a reader can weigh it. It never reaches past
    // the variant to the parent — see `costOf`, and D44 for the price-side
    // version of that mistake.
    await setVariantCost(mediumId, null, 550);
    await completedSale(new Date('2026-03-10T10:00:00.000Z'), [
      { variantId: mediumId, quantity: 1, lineTotal: 1000, rate: 0 },
    ]);

    let report = await reports.margin(shop.tenantId, RANGE);
    expect(report.rows[0]!.costSource).toBe('LATEST_PURCHASE');
    expect(report.rows[0]!.cost).toBe('550.00');

    // A line sold with NO variant is the only case that reads the product's
    // own average — there is no variant to answer for it.
    await resetDatabase(prisma);
    shop = await seedTileShopWithQuickBooks(prisma);
    await prisma.product.update({
      where: { id: shop.productAId },
      data: { averageCost: 700 },
    });
    await completedSale(new Date('2026-03-10T10:00:00.000Z'), [
      { variantId: null, quantity: 2, lineTotal: 2000, rate: 0 },
    ]);
    report = await reports.margin(shop.tenantId, RANGE);
    expect(report.rows[0]!.costSource).toBe('PRODUCT_AVERAGE');
    expect(report.rows[0]!.cost).toBe('1400.00');
  });

  it('keeps the four decimal places of a unit cost until the line is totalled', async () => {
    // averageCost is Decimal(12,4). Rounding 12.3456 to 12.35 first and then
    // multiplying by 1000 units loses 4.40; multiplying first loses nothing.
    await setVariantCost(mediumId, 12.3456);
    await completedSale(new Date('2026-03-10T10:00:00.000Z'), [
      { variantId: mediumId, quantity: 1000, lineTotal: 20000, rate: 0 },
    ]);

    const report = await reports.margin(shop.tenantId, RANGE);
    expect(report.rows[0]!.cost).toBe('12345.60');
    expect(report.rows[0]!.cost).not.toBe('12350.00');
    expect(report.rows[0]!.margin).toBe('7654.40');
  });

  it('costs the margin against revenue net of the order discount', async () => {
    // 1000 sold with 100 off the order, cost 600. The margin is 300, not 400 —
    // the discount came out of the shop's pocket, not the customer's.
    await setVariantCost(mediumId, 600);
    await completedSale(
      new Date('2026-03-10T10:00:00.000Z'),
      [{ variantId: mediumId, quantity: 1, lineTotal: 1000, rate: 0 }],
      { orderDiscount: 100 },
    );

    const report = await reports.margin(shop.tenantId, RANGE);
    expect(report.rows[0]!.revenue).toBe('900.00');
    expect(report.rows[0]!.margin).toBe('300.00');
    expect(report.rows[0]!.marginPercent).toBe('33.33');
  });

  it('shows a loss as a loss', async () => {
    // Sold below cost. A report that could only show a profit would hide the
    // one thing a buyer most needs to see.
    await setVariantCost(mediumId, 1200);
    await completedSale(new Date('2026-03-10T10:00:00.000Z'), [
      { variantId: mediumId, quantity: 1, lineTotal: 1000, rate: 0 },
    ]);

    const report = await reports.margin(shop.tenantId, RANGE);
    expect(report.rows[0]!.margin).toBe('-200.00');
    expect(report.rows[0]!.marginPercent).toBe('-20.00');
    expect(report.totals.margin).toBe('-200.00');
  });

  it('puts the thinnest margin first, and the unknown rows last', async () => {
    await setVariantCost(mediumId, 950);
    await setVariantCost(largeId, null);
    await completedSale(new Date('2026-03-10T10:00:00.000Z'), [
      // Thin: 50.
      { variantId: mediumId, quantity: 1, lineTotal: 1000, rate: 0 },
      // Unknown.
      { variantId: largeId, quantity: 1, lineTotal: 1500, rate: 0 },
    ]);
    await prisma.product.update({ where: { id: shop.productAId }, data: { averageCost: 100 } });
    await completedSale(new Date('2026-03-11T10:00:00.000Z'), [
      // Fat: 900.
      { variantId: null, quantity: 1, lineTotal: 1000, rate: 0 },
    ]);

    const report = await reports.margin(shop.tenantId, RANGE);
    expect(report.rows.map((r) => r.margin)).toEqual(['50.00', '900.00', null]);
  });

  it('says nothing rather than 0% for a period with no sales', async () => {
    const report = await reports.margin(shop.tenantId, RANGE);
    expect(report.rows).toEqual([]);
    expect(report.totals).toEqual({
      revenue: '0.00',
      cost: '0.00',
      margin: '0.00',
      // A percentage of nothing is undefined. "0.00%" would be a claim.
      marginPercent: null,
    });
    expect(report.unknownCost).toEqual({ rows: 0, revenue: '0.00' });
  });

  it('refuses a reversed range', async () => {
    await expect(
      reports.margin(shop.tenantId, { from: RANGE.to, to: RANGE.from }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('agrees with 8.3 about what was sold', async () => {
    await setVariantCost(mediumId, 600);
    await completedSale(new Date('2026-03-10T10:00:00.000Z'), [
      { variantId: mediumId, quantity: 4, lineTotal: 4000, rate: 0 },
    ]);

    const [byVariant, byMargin] = await Promise.all([
      reports.salesByVariant(shop.tenantId, RANGE),
      reports.margin(shop.tenantId, RANGE),
    ]);
    expect(byMargin.rows[0]!.quantitySold).toBe(byVariant.rows[0]!.quantitySold);
    expect(byMargin.rows[0]!.revenue).toBe(byVariant.rows[0]!.revenue);
  });
});

/**
 * `8.6` fixtures.
 *
 * The clock is PINNED. Ageing is arithmetic on dates, and a test that computed
 * its expectations from `Date.now()` would be asserting the same formula the
 * implementation uses — green whatever either of them did. Everything below is
 * measured back from one fixed instant.
 */
const AS_OF = new Date('2026-06-01T12:00:00.000Z');
const daysBefore = (n: number): Date => new Date(AS_OF.getTime() - n * 24 * 60 * 60 * 1000);

async function putOnShelf(variantId: string | null, quantity: number): Promise<void> {
  await prisma.branchInventory.create({
    data: {
      tenantId: shop.tenantId,
      branchId: shop.branchId,
      productId: shop.productAId,
      productVariantId: variantId,
      quantityOnHand: quantity,
    },
  });
}

async function stockIn(variantId: string | null, at: Date, quantity = 10): Promise<void> {
  await prisma.stockMovement.create({
    data: {
      tenantId: shop.tenantId,
      branchId: shop.branchId,
      productId: shop.productAId,
      productVariantId: variantId,
      delta: quantity,
      balanceAfter: quantity,
      reason: 'RECEIPT',
      createdAt: at,
    },
  });
}

describe('8.6 — ageing / slow movers', () => {
  beforeEach(async () => {
    // The shared `beforeEach` seeds stock for the 8.3 sale test; 8.6 reads the
    // stock ledger directly and needs to start from a known shelf.
    await prisma.branchInventory.deleteMany({ where: { tenantId: shop.tenantId } });
  });

  it('the 90-day boundary is inclusive — both sides', async () => {
    // The assertion this whole report turns on. 90 days is slow; 89 is not.
    await putOnShelf(mediumId, 5);
    await putOnShelf(largeId, 5);
    await completedSale(daysBefore(90), [
      { variantId: mediumId, quantity: 1, lineTotal: 1000, rate: 0 },
    ]);
    await completedSale(daysBefore(89), [
      { variantId: largeId, quantity: 1, lineTotal: 1000, rate: 0 },
    ]);

    const report = await reports.ageing(shop.tenantId, { asOf: AS_OF, thresholdDays: 90 });

    // POSITIVE: exactly 90 days is in.
    expect(report.rows.map((r) => r.productVariantId)).toEqual([mediumId]);
    expect(report.rows[0]!.ageDays).toBe(90);
    expect(report.rows[0]!.ageBasis).toBe('LAST_SALE');
    // NEGATIVE: 89 is out. Both sides, or the assertion above would pass for an
    // implementation that returned everything.
    expect(report.rows.map((r) => r.productVariantId)).not.toContain(largeId);
  });

  it('ages from the LAST SALE, not from when the stock arrived', async () => {
    // Arrived a year ago, sold yesterday. Not slow. An implementation measuring
    // from the receipt would call this the oldest thing in the shop.
    await putOnShelf(mediumId, 5);
    await stockIn(mediumId, daysBefore(365));
    await completedSale(daysBefore(1), [
      { variantId: mediumId, quantity: 1, lineTotal: 1000, rate: 0 },
    ]);

    const report = await reports.ageing(shop.tenantId, { asOf: AS_OF, thresholdDays: 90 });
    expect(report.rows).toEqual([]);
    // And the ledger IS there, so this empty answer means "nothing is slow"
    // rather than "nothing to read".
    expect(report.hasStockLedger).toBe(true);
  });

  it('measures a never-sold line from its first stock-in, and says so', async () => {
    await putOnShelf(mediumId, 4);
    await stockIn(mediumId, daysBefore(120));

    const report = await reports.ageing(shop.tenantId, { asOf: AS_OF, thresholdDays: 90 });
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]!.ageBasis).toBe('FIRST_RECEIPT');
    expect(report.rows[0]!.ageDays).toBe(120);
    expect(report.rows[0]!.lastSoldAt).toBeNull();
    expect(report.rows[0]!.firstReceivedAt).toBe(daysBefore(120).toISOString());
  });

  it('takes the FIRST stock-in, not the most recent one', async () => {
    // Restocked last week; it still has not sold since it first arrived.
    await putOnShelf(mediumId, 9);
    await stockIn(mediumId, daysBefore(200));
    await stockIn(mediumId, daysBefore(7));

    const report = await reports.ageing(shop.tenantId, { asOf: AS_OF, thresholdDays: 90 });
    expect(report.rows[0]!.ageDays).toBe(200);
  });

  it('keeps a line whose age cannot be established at all, at the top', async () => {
    // Stock with no sale and no movement: the least accounted-for thing in the
    // shop. Dropping it would hide the worst case behind a null check.
    await putOnShelf(mediumId, 3);
    await putOnShelf(largeId, 3);
    await stockIn(largeId, daysBefore(100));

    const report = await reports.ageing(shop.tenantId, { asOf: AS_OF, thresholdDays: 90 });
    expect(report.rows).toHaveLength(2);
    expect(report.rows[0]!.productVariantId).toBe(mediumId);
    expect(report.rows[0]!.ageBasis).toBe('UNKNOWN');
    expect(report.rows[0]!.ageDays).toBeNull();
    expect(report.rows[1]!.ageDays).toBe(100);
  });

  it('ignores a variant with no stock — sold out is not slow-moving', async () => {
    await putOnShelf(mediumId, 0);
    await stockIn(mediumId, daysBefore(300));

    const report = await reports.ageing(shop.tenantId, { asOf: AS_OF, thresholdDays: 90 });
    expect(report.rows).toEqual([]);
    // The row exists in the ledger; it is the QUANTITY that excluded it.
    expect(report.hasStockLedger).toBe(true);
  });

  it('sums stock across branches', async () => {
    const second = await prisma.branch.create({
      data: { tenantId: shop.tenantId, name: 'Second Branch', code: 'BR2' },
    });
    await putOnShelf(mediumId, 4);
    await prisma.branchInventory.create({
      data: {
        tenantId: shop.tenantId,
        branchId: second.id,
        productId: shop.productAId,
        productVariantId: mediumId,
        quantityOnHand: 6,
      },
    });
    await stockIn(mediumId, daysBefore(150));

    const report = await reports.ageing(shop.tenantId, { asOf: AS_OF, thresholdDays: 90 });
    expect(report.rows[0]!.quantityOnHand).toBe('10.000');
  });

  it('values the sitting stock, and separates what it cannot value (D131)', async () => {
    await setVariantCost(mediumId, 600);
    await putOnShelf(mediumId, 5);
    await putOnShelf(largeId, 2);
    await stockIn(mediumId, daysBefore(120));
    await stockIn(largeId, daysBefore(120));

    const report = await reports.ageing(shop.tenantId, { asOf: AS_OF, thresholdDays: 90 });

    const valued = report.rows.find((r) => r.productVariantId === mediumId)!;
    expect(valued.stockValue).toBe('3000.00');
    expect(valued.costSource).toBe('VARIANT_AVERAGE');

    const unvalued = report.rows.find((r) => r.productVariantId === largeId)!;
    expect(unvalued.stockValue).toBeNull();
    expect(unvalued.costSource).toBe('UNKNOWN');

    // The total is over what could be valued, and says how many rows it left out.
    expect(report.totals.stockValue).toBe('3000.00');
    expect(report.totals.quantityOnHand).toBe('7.000');
    expect(report.unknownCost).toEqual({ rows: 1 });
  });

  it('distinguishes "no stock ledger" from "nothing is slow"', async () => {
    // A tenant with no BranchInventory rows at all. An empty list here means
    // there was nothing to read, and a screen that said "all clear" would be
    // giving a false assurance about a shop it cannot see.
    const report = await reports.ageing(shop.tenantId, { asOf: AS_OF, thresholdDays: 90 });
    expect(report.rows).toEqual([]);
    expect(report.hasStockLedger).toBe(false);
  });

  it('honours a threshold other than 90, at its own boundary', async () => {
    await putOnShelf(mediumId, 5);
    await putOnShelf(largeId, 5);
    await stockIn(mediumId, daysBefore(30));
    await stockIn(largeId, daysBefore(29));

    const report = await reports.ageing(shop.tenantId, { asOf: AS_OF, thresholdDays: 30 });
    expect(report.thresholdDays).toBe(30);
    expect(report.rows.map((r) => r.productVariantId)).toEqual([mediumId]);
  });

  it('defaults to 90 days when no threshold is given', async () => {
    await putOnShelf(mediumId, 5);
    await stockIn(mediumId, daysBefore(95));

    const report = await reports.ageing(shop.tenantId, { asOf: AS_OF });
    expect(report.thresholdDays).toBe(90);
    expect(report.rows).toHaveLength(1);
  });

  it('refuses a threshold that is not a whole number of days', async () => {
    await expect(
      reports.ageing(shop.tenantId, { asOf: AS_OF, thresholdDays: -1 }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      reports.ageing(shop.tenantId, { asOf: AS_OF, thresholdDays: 1.5 }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('is scoped to the tenant', async () => {
    await putOnShelf(mediumId, 5);
    await stockIn(mediumId, daysBefore(200));

    const other = await reports.ageing('some-other-tenant', { asOf: AS_OF });
    expect(other.rows).toEqual([]);
    expect(other.hasStockLedger).toBe(false);
  });
});
