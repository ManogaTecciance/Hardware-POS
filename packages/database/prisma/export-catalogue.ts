/**
 * D191 — export a real workspace's catalogue into a seed pack.
 *
 * ## Why a generator and not a hand-written list
 *
 * The clothing and grocery demo catalogues are a shop somebody actually built
 * in the app: twenty products with variants, barcodes and stock. Retyping that
 * into a TypeScript literal would be a day's work, wrong in three places, and
 * stale the first time a product was added. So the file is generated from the
 * workspace it came from, and regenerated the same way.
 *
 * Usage:
 *
 *     pnpm db:export-catalogue -- --slug kandy-apparel \
 *         --out src/mock-clothing.ts --const CLOTHING_CATALOGUE
 *
 * ## What is deliberately NOT exported
 *
 * Ids, timestamps, `quickbooksItemId`, sync status, image URLs and anything
 * else tied to one database. A pack is matched by natural key (name, SKU,
 * dimension name) precisely so it can be applied to a database that has never
 * seen the workspace it came from. Exporting an id would produce a pack that
 * only works on the machine that made it — which is the bug this whole exercise
 * is fixing.
 *
 * Stock is exported because a demo with zero on hand cannot sell anything, and
 * the numbers are a shape ("about forty shirts") rather than a fact.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

interface Args {
  slug: string;
  out: string;
  constName: string;
  title: string;
  exclude: string[];
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const slug = get('--slug');
  const out = get('--out');
  const constName = get('--const');
  if (!slug || !out || !constName) {
    throw new Error(
      'Usage: tsx prisma/export-catalogue.ts --slug <tenant-slug> --out <path> ' +
        '--const <EXPORT_NAME> [--title "..."] [--exclude "Name,Other Name"]',
    );
  }
  const exclude = (get('--exclude') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return { slug, out, constName, title: get('--title') ?? slug, exclude };
}

/** `2650.00` → `2650`, `0.500` → `0.5`. A Decimal prints its scale; data should not. */
function num(value: unknown): number {
  return Number(String(value));
}

/** Single-quoted TS string with the two characters that can break out escaped. */
function str(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function literal(value: unknown, indent: string): string {
  if (value === null || value === undefined) return 'undefined';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'string') return str(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const inner = value.map((v) => `${indent}  ${literal(v, `${indent}  `)}`).join(',\n');
    return `[\n${inner},\n${indent}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).filter(
    ([, v]) => v !== undefined,
  );
  if (entries.length === 0) return '{}';
  const inner = entries
    .map(([k, v]) => `${indent}  ${/^[A-Za-z_$][\w$]*$/.test(k) ? k : str(k)}: ${literal(v, `${indent}  `)}`)
    .join(',\n');
  return `{\n${inner},\n${indent}}`;
}

async function main(): Promise<void> {
  const { slug, out, constName, title, exclude } = parseArgs();

  const tenant = await prisma.tenant.findFirst({ where: { slug }, select: { id: true, name: true } });
  if (!tenant) {
    const all = await prisma.tenant.findMany({ select: { slug: true }, orderBy: { slug: 'asc' } });
    throw new Error(
      `No tenant with slug '${slug}'. Available: ${all.map((t) => t.slug).join(', ')}`,
    );
  }

  const categories = await prisma.productCategory.findMany({
    where: { tenantId: tenant.id, parentId: null },
    select: { name: true },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
  });

  /*
   * `--exclude` keeps a product out of the PACK; it does not delete anything.
   *
   * The workspaces these packs come from are real and traded-in, so the
   * experiments in them are not inert: `Test-3` alone carries twelve sale lines
   * and four quotation lines. `SaleItem.productId` is ON DELETE SET NULL and
   * `StockMovement` is CASCADE, so deleting one would orphan real sale lines and
   * silently destroy its stock history. Excluding costs the author nothing and
   * risks nothing, and the team still gets a catalogue with no `Test-3` in it.
   *
   * Matched by NAME rather than SKU because the products worth excluding tend to
   * be the ones nobody bothered to give a SKU.
   */
  const products = await prisma.product.findMany({
    where: { tenantId: tenant.id, ...(exclude.length > 0 ? { name: { notIn: exclude } } : {}) },
    orderBy: [{ name: 'asc' }],
    select: {
      id: true, name: true, sku: true, type: true, description: true,
      unitPrice: true, costPrice: true, quantityType: true, unitOfMeasure: true,
      reorderLevel: true, attributes: true, taxable: true, quantityOnHand: true,
      hasVariants: true,
      category: { select: { name: true } },
      subcategory: { select: { name: true } },
      brand: { select: { name: true } },
      variationDimensions: {
        orderBy: { position: 'asc' },
        select: { name: true, options: { orderBy: { position: 'asc' }, select: { name: true } } },
      },
      variants: {
        orderBy: { position: 'asc' },
        select: {
          id: true, sku: true, barcode: true, unitPrice: true, costPrice: true, isDefault: true,
          optionValues: {
            select: { dimension: { select: { name: true } }, option: { select: { name: true } } },
          },
        },
      },
    },
  });

  // One query for every stock row, rather than one per variant.
  const stock = await prisma.branchInventory.findMany({
    where: { tenantId: tenant.id },
    select: { productId: true, productVariantId: true, quantityOnHand: true },
  });
  const stockByVariant = new Map<string, number>();
  const stockByProduct = new Map<string, number>();
  for (const row of stock) {
    if (row.productVariantId) stockByVariant.set(row.productVariantId, num(row.quantityOnHand));
    else stockByProduct.set(row.productId, num(row.quantityOnHand));
  }

  let variantCount = 0;
  const shaped = products.map((p) => {
    const attributes = p.attributes as Record<string, unknown> | null;
    const hasAttributes = attributes && Object.keys(attributes).length > 0;
    const variants = p.variants.map((v) => {
      variantCount += 1;
      const options: Record<string, string> = {};
      for (const ov of v.optionValues) options[ov.dimension.name] = ov.option.name;
      return {
        sku: v.sku,
        barcode: v.barcode ?? undefined,
        unitPrice: num(v.unitPrice),
        costPrice: v.costPrice === null ? undefined : num(v.costPrice),
        options,
        quantityOnHand: stockByVariant.get(v.id),
        isDefault: v.isDefault || undefined,
      };
    });
    return {
      name: p.name,
      sku: p.sku ?? undefined,
      type: p.type,
      description: p.description ?? undefined,
      category: p.category?.name ?? undefined,
      subcategory: p.subcategory?.name ?? undefined,
      brand: p.brand?.name ?? undefined,
      unitPrice: num(p.unitPrice),
      costPrice: p.costPrice === null ? undefined : num(p.costPrice),
      quantityType: p.quantityType === 'WHOLE' ? undefined : p.quantityType,
      unitOfMeasure: p.unitOfMeasure ?? undefined,
      reorderLevel: p.reorderLevel === null ? undefined : num(p.reorderLevel),
      attributes: hasAttributes ? attributes : undefined,
      taxable: p.taxable ? undefined : false,
      quantityOnHand: variants.length > 0 ? undefined : (stockByProduct.get(p.id) ?? num(p.quantityOnHand)),
      dimensions:
        p.variationDimensions.length > 0
          ? p.variationDimensions.map((d) => ({ name: d.name, options: d.options.map((o) => o.name) }))
          : undefined,
      variants: variants.length > 0 ? variants : undefined,
    };
  });

  const pack = { categories: categories.map((c) => c.name), products: shaped };

  // Which exclusions actually matched, so the report can say so.
  const excluded = (
    await prisma.product.findMany({
      where: { tenantId: tenant.id, name: { in: exclude } },
      select: { name: true },
      orderBy: { name: 'asc' },
    })
  ).map((p) => p.name);

  const header = `/**
 * ${title} — generated catalogue, do NOT hand-edit.
 *
 * Exported from the \`${slug}\` workspace by \`prisma/export-catalogue.ts\`
 * (D191). Pure data with no runtime dependencies, the same contract
 * \`mock-catalog.ts\` keeps, so the Prisma seed and the API can both import it.
 *
 * Contains no ids or timestamps: a pack is applied by natural key (category
 * name, product SKU, dimension name) precisely so it can be written into a
 * database that has never seen the workspace it came from.
 *
 * To refresh after changing the shop in the app:
 *
 *     pnpm db:export-catalogue -- --slug ${slug} --out ${out} --const ${constName}
 *
 * ${pack.products.length} products · ${variantCount} variants · ${pack.categories.length} categories
 */
import type { CataloguePack } from './catalogue-pack';

export const ${constName}: CataloguePack = `;

  const body = `${literal(pack, '')};\n`;
  const path = resolve(process.cwd(), out);
  writeFileSync(path, `${header}${body}`, 'utf8');

  /* eslint-disable no-console */
  console.log(`Exported '${tenant.name}' (${slug})`);
  console.log(`  ${pack.categories.length} categories, ${pack.products.length} products, ${variantCount} variants`);
  if (exclude.length > 0) {
    // Named, and counted, so a typo in --exclude is visible rather than silent.
    const missed = exclude.filter((name) => !excluded.includes(name));
    console.log(`  excluded ${excluded.length}: ${excluded.join(', ') || '(none matched)'}`);
    if (missed.length > 0) console.log(`  !! no product named: ${missed.join(', ')}`);
  }
  console.log(`  -> ${path}`);
  /* eslint-enable no-console */
}

main()
  .catch((error: unknown) => {
    /* eslint-disable-next-line no-console */
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
