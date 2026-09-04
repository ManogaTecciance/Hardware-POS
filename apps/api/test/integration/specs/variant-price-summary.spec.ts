/**
 * D44 — the products list must price a variant product from its variants.
 *
 * ## What was wrong
 *
 * `Product.unitPrice` and `Product.sku` are legacy fallbacks the schema says are
 * "not read" once `hasVariants` is true. The admin products list, the promotion
 * product picker and the product-detail KPI all read them anyway, so every
 * variant product in the pilot catalogue rendered `Rs 0.00` and `SKU —` while
 * its variants were priced 500 to 4,300.
 *
 * ## What can only be proven here, not in a unit spec
 *
 *  • `groupBy` with `_min`/`_max` over a `Decimal(12,2)` column returns Prisma
 *    `Decimal` objects, not numbers. A mocked client would happily hand back
 *    JavaScript numbers and prove nothing about the conversion — and a Decimal
 *    that reached the client would serialise as an object, not a price.
 *  • the `isActive` filter, which is a real WHERE clause against real rows.
 *  • that `paginate` carries the widened row through untouched.
 *
 * ## What makes these assertions non-vacuous (D30)
 *
 * A legacy product and a variant product are asserted in the SAME list response.
 * "The variant product has a span" alone would pass for a service that ranged
 * every product; the legacy row asserts the old reading is untouched, which is
 * what protects the 40-odd hardware and restaurant products already priced
 * correctly. The mutation proof at the end runs the assertions against the
 * defect as it shipped.
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
import { ProductsService } from '../../../src/modules/products/products.service';
import { QueryProductsDto } from '../../../src/modules/products/dto/query-products.dto';

import { connectTestPrisma, disconnectTestPrisma } from '../prisma-test-client';
import { resetDatabase } from '../db-reset';
import { seedTileShopWithQuickBooks, type SeededTenant } from '../fixtures';

let prisma: PrismaClient;
let testModule: TestingModule;
let products: ProductsService;
let tile: SeededTenant;

beforeAll(async () => {
  prisma = await connectTestPrisma();
  testModule = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
      StorageModule,
      PrismaModule,
      PlatformModule,
      ProvidersModule,
      // ProductsModule reaches QuickBooksModule, which needs JwtService.
      // SalesModule supplies it transitively — the same graph `variant-stock`
      // and `providers.spec` compile.
      SalesModule,
      ProductsModule,
    ],
  }).compile();
  testModule.useLogger(false);
  await testModule.init();
  products = testModule.get(ProductsService);
});

afterAll(async () => {
  await testModule.close();
  await disconnectTestPrisma();
});

beforeEach(async () => {
  await resetDatabase(prisma);
  tile = await seedTileShopWithQuickBooks(prisma);
  await prisma.tenantBusinessProfile.create({
    data: {
      tenantId: tile.tenantId,
      businessType: BusinessType.HARDWARE,
      inventoryMode: InventoryMode.LOCAL,
      accountingProvider: AccountingProviderKind.NONE,
    },
  });
});

function query(): QueryProductsDto {
  return Object.assign(new QueryProductsDto(), { page: 1, pageSize: 50 });
}

/**
 * Turn `productAId` into a variant product, mirroring what the matrix editor
 * writes: parent price and SKU are left as the meaningless legacy values the
 * real rows carry, so the fixture is the production shape and not a tidied-up
 * version of it.
 */
async function makeVariantProduct(
  prices: { sku: string; price: number; isActive?: boolean }[],
): Promise<void> {
  await prisma.product.update({
    where: { id: tile.productAId },
    data: { hasVariants: true, unitPrice: 0, sku: null },
  });
  for (const p of prices) {
    await prisma.productVariant.create({
      data: {
        tenantId: tile.tenantId,
        productId: tile.productAId,
        sku: p.sku,
        unitPrice: p.price,
        isActive: p.isActive ?? true,
      },
    });
  }
}

async function rowFor(id: string) {
  const page = await products.list(tile.tenantId, query());
  const row = page.items.find((p) => p.id === id);
  if (!row) throw new Error(`product ${id} missing from the list response`);
  return row;
}

describe('the products list prices a variant product from its variants (D44)', () => {
  it('returns the span, as numbers, across active variants only', async () => {
    await makeVariantProduct([
      { sku: 'SHT-30', price: 1200 },
      { sku: 'SHT-32', price: 4300 },
      // Deactivated: a discontinued colour must not widen the range an
      // operator is shown. Priced outside the span on BOTH sides so a missing
      // filter shows up whichever bound it corrupts.
      { sku: 'SHT-34', price: 9999, isActive: false },
      { sku: 'SHT-36', price: 1, isActive: false },
    ]);

    const row = await rowFor(tile.productAId);

    expect(row.variantCount).toBe(2);
    expect(row.variantPriceMin).toBe(1200);
    expect(row.variantPriceMax).toBe(4300);

    // Numbers, not Prisma Decimals. A Decimal survives `toBe(1200)` never —
    // but it WOULD survive a loose `==`, and it serialises to JSON as an
    // object, which is precisely how a price becomes "[object Object]" on the
    // screen. Asserted explicitly rather than trusted.
    expect(typeof row.variantPriceMin).toBe('number');
    expect(typeof row.variantPriceMax).toBe('number');

    // The parent columns are untouched — this change adds a reading, it does
    // not rewrite the row. Their being meaningless here is the whole point.
    expect(Number(row.unitPrice)).toBe(0);
    expect(row.sku).toBeNull();
  });

  it('collapses to a single figure when every variant agrees', async () => {
    await makeVariantProduct([
      { sku: 'TIE-RED', price: 500 },
      { sku: 'TIE-BLA', price: 500 },
      { sku: 'TIE-BLU', price: 500 },
    ]);

    const row = await rowFor(tile.productAId);

    expect(row.variantCount).toBe(3);
    expect(row.variantPriceMin).toBe(500);
    expect(row.variantPriceMax).toBe(500);
  });

  it('leaves a legacy product alone, in the same response', async () => {
    await makeVariantProduct([{ sku: 'SHT-30', price: 1200 }]);

    const page = await products.list(tile.tenantId, query());
    const legacy = page.items.find((p) => p.id === tile.productBId);
    const variant = page.items.find((p) => p.id === tile.productAId);

    // NEGATIVE: a variant-less product reports no variants and no bounds, so a
    // screen can tell "no variants" from "one variant priced the same" — and
    // keeps reading its own `unitPrice`, exactly as before.
    expect(legacy!.variantCount).toBe(0);
    expect(legacy!.variantPriceMin).toBeNull();
    expect(legacy!.variantPriceMax).toBeNull();
    expect(Number(legacy!.unitPrice)).toBeGreaterThan(0);

    // POSITIVE control in the same response, so a run where the aggregate
    // silently returned nothing at all cannot pass on the negative alone.
    expect(variant!.variantCount).toBe(1);
  });

  it('reports no variants once every variant is deactivated', async () => {
    await makeVariantProduct([
      { sku: 'SHT-30', price: 1200, isActive: false },
      { sku: 'SHT-32', price: 4300, isActive: false },
    ]);

    const row = await rowFor(tile.productAId);

    // `hasVariants` stays true on the row, so the client must decide from the
    // count — which is why `pricedByVariants` reads both. Bounds are null
    // rather than 0, because there is no price here, not a price of zero.
    expect(row.hasVariants).toBe(true);
    expect(row.variantCount).toBe(0);
    expect(row.variantPriceMin).toBeNull();
  });

  it('does not leak another tenant’s variants into the span', async () => {
    await makeVariantProduct([{ sku: 'SHT-30', price: 1200 }]);

    // A second tenant with a variant priced far outside the span. The aggregate
    // is keyed by productId; without the tenant predicate a shared product id
    // would be enough to pull it in.
    const other = await prisma.tenant.create({
      data: { name: 'Other Shop', slug: `other-${Date.now()}` },
    });
    await prisma.productVariant.create({
      data: {
        tenantId: other.id,
        productId: tile.productAId,
        sku: 'LEAK-1',
        unitPrice: 99999,
      },
    });

    const row = await rowFor(tile.productAId);

    expect(row.variantCount).toBe(1);
    expect(row.variantPriceMax).toBe(1200);
  });
});

/*
 * MUTATION PROOF (D30 §5) — every line below is a run that was actually
 * executed against this spec, not a prediction.
 *
 * 1. The defect as it shipped — no aggregate is fetched, so the screens read the
 *    parent columns (`variantIds` forced to `[]`):
 *      × returns the span, as numbers, across active variants only
 *      × collapses to a single figure when every variant agrees
 *      × leaves a legacy product alone, in the same response
 *      × does not leak another tenant's variants into the span
 *      √ reports no variants once every variant is deactivated
 *          — NOTED HONESTLY: "no aggregate at all" and "every variant is
 *            deactivated" are observationally identical (count 0, null bounds),
 *            so that case cannot distinguish them and is not claimed to. The
 *            other four carry the guard.
 *      4 of 5 fail.
 *
 * 2. Dropping `isActive: true` from the groupBy WHERE:
 *      × returns the span, as numbers, across active variants only
 *          (reads min 1 / max 9999 — BOTH bounds corrupted, which is why the
 *           fixture deactivates a variant on either side of the real span)
 *      × reports no variants once every variant is deactivated
 *      2 of 5 fail. The three that pass have no inactive variants to mis-read.
 *
 * 3. Dropping `tenantId` from the groupBy WHERE:
 *      × does not leak another tenant's variants into the span
 *      1 of 5 fails — that test is the ONLY guard on tenant isolation here,
 *      which is exactly why it is written as its own case rather than folded
 *      into another assertion.
 *
 * 4. Returning the raw Prisma `Decimal` instead of `Number(...)`:
 *      × returns the span, as numbers, across active variants only
 *      × collapses to a single figure when every variant agrees
 *      × does not leak another tenant's variants into the span
 *      3 of 5 fail. This is the mutation a mocked client could never catch: a
 *      Decimal reaching the browser serialises as an object, not a price.
 */
