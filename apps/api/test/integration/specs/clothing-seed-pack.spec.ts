import { variantDisplayName } from '../../../src/common/variant-display';
import {
  seedClothingPack,
  CLOTHING_CATEGORIES,
  type PrismaClient,
} from '@hardware-pos/database';

import { connectTestPrisma, disconnectTestPrisma } from '../prisma-test-client';
import { resetDatabase } from '../db-reset';
import { seedTileShopWithQuickBooks, type SeededTenant } from '../fixtures';

/**
 * D99 (2.6) — the clothing seed pack, against real PostgreSQL.
 *
 * What can only be proven here: that the four-level chain
 * `Dimension -> Option -> Variant -> VariantOptionValue` is actually linked. A
 * unit test with a mocked client would let every `create` succeed and tell us
 * nothing about whether the LINKS exist — and a missing link is silent, because
 * `variantDisplayName` falls back to the SKU rather than failing.
 *
 * That fallback is the whole reason this spec asserts display names rather than
 * row counts.
 */
let prisma: PrismaClient;
let tenant: SeededTenant;

beforeAll(async () => {
  prisma = await connectTestPrisma();
});

afterAll(async () => {
  await disconnectTestPrisma();
});

beforeEach(async () => {
  await resetDatabase(prisma);
  tenant = await seedTileShopWithQuickBooks(prisma);
});

async function seed(withSamples: boolean) {
  return prisma.$transaction((tx) =>
    seedClothingPack(tx, tenant.tenantId, tenant.branchId, { withSamples }),
  );
}

async function variantsOf(productName: string) {
  return prisma.productVariant.findMany({
    where: { tenantId: tenant.tenantId, product: { name: productName } },
    include: { optionValues: { include: { option: { select: { name: true } } } } },
    orderBy: { position: 'asc' },
  });
}

describe('categories are always seeded', () => {
  it('creates exactly the five clothing categories, in order', async () => {
    const result = await seed(false);

    const rows = await prisma.productCategory.findMany({
      where: { tenantId: tenant.tenantId },
      orderBy: { sortOrder: 'asc' },
    });

    expect(rows.map((c) => c.name)).toEqual([...CLOTHING_CATEGORIES]);
    expect(result.categories).toBe(5);
  });

  it('seeds NO products without the flag', async () => {
    // The negative half, and the decision this pack turns on: seeded rows are
    // frozen in a tenant's database, so a starter product a shop has to delete
    // is worse than none at all.
    const result = await seed(false);

    expect(result.products).toBe(0);
    expect(result.variants).toBe(0);
    expect(await prisma.product.count({ where: { tenantId: tenant.tenantId } })).toBe(
      // The fixture's own products, untouched — not zero, which would pass even
      // if the pack had deleted things.
      await prisma.product.count({ where: { tenantId: tenant.tenantId, hasVariants: false } }),
    );
    expect(
      await prisma.product.count({ where: { tenantId: tenant.tenantId, hasVariants: true } }),
    ).toBe(0);
  });

  it('is idempotent — running twice creates nothing new', async () => {
    await seed(false);
    await seed(false);

    expect(await prisma.productCategory.count({ where: { tenantId: tenant.tenantId } })).toBe(5);
  });
});

describe('sample products build the whole variant chain', () => {
  it('creates the cross product for a two-axis product', async () => {
    const result = await seed(true);

    // 4 sizes x 3 colours = 12, plus 4 waist sizes = 16.
    expect(result.products).toBe(2);
    expect(result.variants).toBe(16);
    expect(await variantsOf('Cotton T-Shirt')).toHaveLength(12);
    expect(await variantsOf('Denim Jeans')).toHaveLength(4);
  });

  it('links every variant to its option values, so names are not SKUs', async () => {
    // THE assertion this spec exists for. Skip the ProductVariantOptionValue
    // rows and every create still succeeds — the failure only shows up as a
    // display name, because `variantDisplayName` falls back to the SKU.
    await seed(true);

    const names = (await variantsOf('Cotton T-Shirt')).map((v) =>
      variantDisplayName(v.optionValues, v.sku),
    );

    expect(names).toContain('M / Black');
    expect(names).toContain('XL / Navy');
    // Negative half: no name may be a bare SKU.
    for (const name of names) {
      expect(name).not.toMatch(/^TSHIRT-/);
    }
  });

  it('names a single-axis product from its one dimension', async () => {
    await seed(true);

    const names = (await variantsOf('Denim Jeans')).map((v) =>
      variantDisplayName(v.optionValues, v.sku),
    );

    expect(names).toEqual(['30', '32', '34', '36']);
  });

  it('orders options by position, not alphabetically', async () => {
    // Alphabetical sizing gives L, M, S, XL. `position` is the only thing that
    // makes a size scale read correctly.
    await seed(true);

    const options = await prisma.productVariationOption.findMany({
      where: { tenantId: tenant.tenantId, dimension: { name: 'Size', product: { name: 'Cotton T-Shirt' } } },
      orderBy: { position: 'asc' },
    });

    expect(options.map((o) => o.name)).toEqual(['S', 'M', 'L', 'XL']);
  });

  it('marks exactly one default per product, and it is the declared one', async () => {
    // Without a default, 1c.4's quick-add ladder never fires and every tap opens
    // the picker. With two, the partial unique index rejects the write.
    await seed(true);

    for (const [productName, expected] of [
      ['Cotton T-Shirt', 'M / Black'],
      ['Denim Jeans', '32'],
    ] as const) {
      const defaults = (await variantsOf(productName)).filter((v) => v.isDefault);

      expect(defaults).toHaveLength(1);
      expect(variantDisplayName(defaults[0]!.optionValues, defaults[0]!.sku)).toBe(expected);
    }
  });

  it('gives every variant its own branch stock row and a distinct barcode', async () => {
    await seed(true);

    const variants = await variantsOf('Cotton T-Shirt');
    const stock = await prisma.branchInventory.findMany({
      where: { tenantId: tenant.tenantId, productVariantId: { in: variants.map((v) => v.id) } },
    });

    expect(stock).toHaveLength(12);
    expect(stock.every((s) => Number(s.quantityOnHand) === 10)).toBe(true);
    // A shared barcode would make two sizes scan to the same line — the exact
    // failure 1c.5 exists to prevent.
    const barcodes = variants.map((v) => v.barcode);
    expect(new Set(barcodes).size).toBe(barcodes.length);
  });

  it('leaves the parent price at zero — variants own the price (D44)', async () => {
    await seed(true);

    const product = await prisma.product.findFirstOrThrow({
      where: { tenantId: tenant.tenantId, name: 'Cotton T-Shirt' },
    });

    expect(product.hasVariants).toBe(true);
    expect(Number(product.unitPrice)).toBe(0);
    expect((await variantsOf('Cotton T-Shirt')).every((v) => Number(v.unitPrice) === 1850)).toBe(
      true,
    );
  });

  it('is idempotent with samples too', async () => {
    await seed(true);
    const second = await seed(true);

    expect(second.products).toBe(0);
    expect(await prisma.productVariant.count({ where: { tenantId: tenant.tenantId } })).toBe(16);
  });
});

describe('no footwear scale is seeded (deliberate)', () => {
  it('ships the Footwear category with no sizes behind it', async () => {
    // UK vs EU sizing is a live question for the Sri Lankan market, and a wrong
    // scale seeded into a tenant cannot be corrected in code. The category is
    // useful on its own; the scale waits for someone who knows.
    await seed(true);

    const footwear = await prisma.productCategory.findFirstOrThrow({
      where: { tenantId: tenant.tenantId, name: 'Footwear' },
    });

    expect(await prisma.product.count({ where: { categoryId: footwear.id } })).toBe(0);
  });
});
