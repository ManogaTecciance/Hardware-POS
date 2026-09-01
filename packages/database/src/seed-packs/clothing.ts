/**
 * The clothing seed pack (D99, 2.6).
 *
 * ## Why categories are always seeded and products are not
 *
 * `provision-tenant` already makes this argument about modules:
 *
 * > "No `TenantModule` rows: with a profile and no explicit per-module opinion
 * > the API resolves the defaults for the business type. Writing them here would
 * > freeze today's defaults into every tenant provisioned today."
 *
 * The same asymmetry decides this file. Descriptor data lives in code and is
 * resolved at read time, so a correction reaches every tenant at once. **Seeded
 * rows live in the tenant's database and are frozen**: fixing a wrong starter
 * product tomorrow reaches nobody provisioned today.
 *
 * So the pack seeds what is cheap to be wrong about and expensive to omit:
 *
 *  - **Categories, always.** A category is a container. Renaming or deleting one
 *    costs nothing; a shop with none has to invent five before filing a product.
 *  - **Starter products, only behind `--with-samples`.** A real shop deletes
 *    whatever we invent, and a product carries a variant chain, barcodes and
 *    stock rows that are frozen the moment they are written.
 *
 * ## No footwear scale, deliberately
 *
 * The Footwear *category* ships; its size scale does not. UK and EU sizing are
 * both plausible in the Sri Lankan market, the answer needs a local retailer
 * rather than a guess, and a wrong scale seeded into tenants cannot be corrected
 * in code. Apparel letter sizes and waist inches carry no such ambiguity.
 *
 * ## Why the option-value link is not optional
 *
 * `ProductVariant` has **no `name` column**: its readable name is derived from
 * the options it carries. Create a variant without its
 * `ProductVariantOptionValue` rows and `variantDisplayName` falls back to the
 * SKU, so the picker shows `TSHIRT-M-BLACK` where it should show
 * `Black / Medium`. The fallback is deliberate (an unlovely code beats a blank
 * line on a receipt), which is exactly why the mistake is silent. It happened on
 * the first Phase 1 demo product.
 */
import type { Prisma, PrismaClient } from '@prisma/client';

type Db = PrismaClient | Prisma.TransactionClient;

/** Top-level categories every clothing workspace starts with. */
export const CLOTHING_CATEGORIES: readonly string[] = [
  'Menswear',
  'Womenswear',
  'Kidswear',
  'Footwear',
  'Accessories',
];

/** Waist measurements in inches, for trousers. */
const WAIST_SIZES: readonly string[] = ['30', '32', '34', '36'];

const COLOURS: readonly string[] = ['Black', 'White', 'Navy'];

interface SampleSpec {
  name: string;
  category: string;
  skuPrefix: string;
  unitPrice: number;
  /** One entry per axis. Two axes produce the cross product of variants. */
  dimensions: { name: string; options: readonly string[] }[];
  /** Which option combination quick-adds when the card is tapped (D45). */
  defaultOptions: string[];
  openingStock: number;
}

/**
 * Two products, chosen to exercise both shapes: a two-axis cross product and a
 * single-axis list. The two-axis case is where option-value linking is actually
 * tested, because a variant there carries one value per dimension, which is what
 * produces "Black / Medium" rather than just "Medium".
 */
const SAMPLES: readonly SampleSpec[] = [
  {
    name: 'Cotton T-Shirt',
    category: 'Menswear',
    skuPrefix: 'TSHIRT',
    unitPrice: 1850,
    dimensions: [
      { name: 'Size', options: ['S', 'M', 'L', 'XL'] },
      { name: 'Colour', options: COLOURS },
    ],
    defaultOptions: ['M', 'Black'],
    openingStock: 10,
  },
  {
    name: 'Denim Jeans',
    category: 'Menswear',
    skuPrefix: 'JEANS',
    unitPrice: 4500,
    dimensions: [{ name: 'Size', options: WAIST_SIZES }],
    defaultOptions: ['32'],
    openingStock: 6,
  },
];

/** Every combination across the axes, in declaration order. */
function combinations(dimensions: SampleSpec['dimensions']): string[][] {
  return dimensions.reduce<string[][]>(
    (acc, dim) => acc.flatMap((combo) => dim.options.map((opt) => [...combo, opt])),
    [[]],
  );
}

/** `TSHIRT-M-BLACK` -- readable on a shelf label and stable for reordering. */
function skuFor(prefix: string, combo: readonly string[]): string {
  return [prefix, ...combo.map((c) => c.toUpperCase().replace(/[^A-Z0-9]/g, ''))].join('-');
}

/**
 * Seed a clothing tenant's catalogue.
 *
 * Idempotent on `(tenantId, name)` for categories and `(tenantId, sku)` for
 * variants, so running it twice adds nothing. Call inside the caller's
 * transaction: a half-seeded tenant is worse than an unseeded one.
 */
export async function seedClothingPack(
  db: Db,
  tenantId: string,
  branchId: string,
  options: { withSamples?: boolean } = {},
): Promise<{ categories: number; products: number; variants: number }> {
  const categoryIds = new Map<string, string>();

  for (const [index, name] of CLOTHING_CATEGORIES.entries()) {
    const existing = await db.productCategory.findFirst({ where: { tenantId, name } });
    const row =
      existing ??
      (await db.productCategory.create({
        data: { tenantId, name, sortOrder: index, isActive: true },
      }));
    categoryIds.set(name, row.id);
  }

  if (!options.withSamples) {
    return { categories: categoryIds.size, products: 0, variants: 0 };
  }

  let products = 0;
  let variants = 0;

  for (const spec of SAMPLES) {
    const combos = combinations(spec.dimensions);
    const firstSku = skuFor(spec.skuPrefix, combos[0]!);
    if (await db.productVariant.findFirst({ where: { tenantId, sku: firstSku } })) {
      continue; // already seeded
    }

    const product = await db.product.create({
      data: {
        tenantId,
        name: spec.name,
        categoryId: categoryIds.get(spec.category) ?? null,
        type: 'Inventory',
        // The parent carries no meaningful price: a variant product's price
        // lives on its variants (D44), and the read model sends null for it.
        unitPrice: 0,
        hasVariants: true,
        isActive: true,
      },
    });
    products += 1;

    // Dimension -> Option, capturing ids for the value links below.
    const optionIds = new Map<string, string>(); // "Size:M" -> optionId
    const dimensionIds = new Map<string, string>();
    for (const [dIndex, dim] of spec.dimensions.entries()) {
      const dimension = await db.productVariationDimension.create({
        data: { tenantId, productId: product.id, name: dim.name, position: dIndex },
      });
      dimensionIds.set(dim.name, dimension.id);
      for (const [oIndex, optName] of dim.options.entries()) {
        const option = await db.productVariationOption.create({
          data: {
            tenantId,
            dimensionId: dimension.id,
            name: optName,
            // Declaration order, NOT alphabetical: sizes read S, M, L, XL only
            // because position says so.
            position: oIndex,
          },
        });
        optionIds.set(dim.name + ':' + optName, option.id);
      }
    }

    for (const [vIndex, combo] of combos.entries()) {
      const isDefault =
        combo.length === spec.defaultOptions.length &&
        combo.every((c, i) => c === spec.defaultOptions[i]);

      const variant = await db.productVariant.create({
        data: {
          tenantId,
          productId: product.id,
          sku: skuFor(spec.skuPrefix, combo),
          // Internal 13-digit code. Phase 5 allocates real EAN-13s from a
          // configured prefix; this is a placeholder that scans.
          barcode: '299' + String(products).padStart(4, '0') + String(vIndex).padStart(6, '0'),
          unitPrice: spec.unitPrice,
          isDefault,
          isActive: true,
          position: vIndex,
        },
      });
      variants += 1;

      // The link that makes `variantDisplayName` return "Black / Medium".
      // Omitting it is silent: the name falls back to the SKU.
      for (const [dIndex, dim] of spec.dimensions.entries()) {
        await db.productVariantOptionValue.create({
          data: {
            tenantId,
            variantId: variant.id,
            dimensionId: dimensionIds.get(dim.name)!,
            optionId: optionIds.get(dim.name + ':' + combo[dIndex])!,
          },
        });
      }

      // Variant stock is branch-scoped and normally arrives by goods receipt
      // (D99 decision 8). Opening stock is written directly here because a
      // sample product with no stock cannot be sold, and a receipt would need a
      // supplier this tenant does not have.
      await db.branchInventory.create({
        data: {
          tenantId,
          branchId,
          productId: product.id,
          productVariantId: variant.id,
          quantityOnHand: spec.openingStock,
          reorderLevel: 3,
        },
      });
    }
  }

  return { categories: categoryIds.size, products, variants };
}
