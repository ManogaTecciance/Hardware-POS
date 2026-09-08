/**
 * `GET /products/sellable?search=` — dietary tags match regardless of case.
 *
 * Prisma's `has` is exact array-element equality with no case-insensitive
 * form, so the tag half of this search was case-sensitive while the name and
 * subcategory halves were not: "Veg" found fourteen rows, "veg" found two.
 * Lower-case is what a cashier types at a till.
 *
 * ## Why this is an integration spec and not a unit test
 *
 * The fix resolves the tenant's own tag spellings with a raw `unnest` +
 * `lower()` query. A unit test would have to mock `$queryRaw`, which proves
 * only that the mock was called — it could not tell a correct SQL string from
 * a broken one, and would stay green if the query returned another tenant's
 * tags. Real Postgres is the only thing that can answer this (D30 §4).
 *
 * ## Held in both directions
 *
 *  - POSITIVE: every casing of a stored tag finds the same rows, including a
 *    hyphenated tag, where generating case variants would have failed.
 *  - NEGATIVE: the match stays an EQUALITY — a prefix of a tag does not match
 *    it — and one tenant's spellings never satisfy another tenant's search.
 */
import type { PrismaClient } from '@hardware-pos/database';

import { connectTestPrisma, disconnectTestPrisma } from '../prisma-test-client';
import { resetDatabase } from '../db-reset';
import { seedTenant, type SeededTenant } from '../fixtures';
import { createHttpIntegrationApp, type HttpIntegrationApp } from '../http-test-app';

let prisma: PrismaClient;
let http: HttpIntegrationApp;
let restaurant: SeededTenant;
let other: SeededTenant;

interface SellablePage {
  items: Array<{ id: string; name: string }>;
  total: number;
  nextCursor: string | null;
}

const tokenFor = (t: SeededTenant) =>
  http.tokenFor({
    userId: t.ownerId,
    tenantId: t.tenantId,
    role: 'OWNER',
    activeBranchId: t.branchId,
  });

async function search(t: SeededTenant, term: string): Promise<string[]> {
  const res = await http.request<{ data: SellablePage }>(
    'get',
    `/products/sellable?branchId=${encodeURIComponent(t.branchId)}&search=${encodeURIComponent(term)}`,
    { token: tokenFor(t) },
  );
  expect(res.status).toBe(200);
  const body = res.data as unknown as SellablePage;
  return body.items.map((i) => i.name).sort();
}

async function makeProduct(
  t: SeededTenant,
  name: string,
  sku: string,
  dietaryTags: string[],
): Promise<void> {
  await prisma.product.create({
    data: {
      tenantId: t.tenantId,
      name,
      type: 'Inventory',
      sku,
      unitPrice: '500.00',
      quantityOnHand: '10.000',
      isActive: true,
      dietaryTags,
    },
  });
}

beforeAll(async () => {
  prisma = await connectTestPrisma();
  http = await createHttpIntegrationApp();
});

afterAll(async () => {
  await http.close();
  await disconnectTestPrisma();
});

beforeEach(async () => {
  await resetDatabase(prisma);
  restaurant = await seedTenant(prisma, {
    prefix: 'tagsearch',
    name: 'Tag Search Restaurant',
    slug: 'tag-search-restaurant',
  });
  other = await seedTenant(prisma, {
    prefix: 'tagother',
    name: 'Other Tenant',
    slug: 'tag-other-tenant',
  });

  // Stored casing is mixed on purpose — that is the whole point.
  await makeProduct(restaurant, 'Garden Salad', 'TS-SALAD', ['Veg']);
  await makeProduct(restaurant, 'Papadam', 'TS-PAPADAM', ['Veg', 'Gluten-Free']);
  await makeProduct(restaurant, 'Chicken Wings', 'TS-WINGS', ['Spicy']);
  // Name contains "veg" but carries no tag, so it separates a name hit from a
  // tag hit — without it, "veg" returning rows would prove nothing.
  await makeProduct(restaurant, 'Vegetable Curry', 'TS-VEGCURRY', []);
});

describe('dietary-tag search is case-insensitive', () => {
  it('finds the same rows for every casing of a stored tag', async () => {
    const expected = ['Garden Salad', 'Papadam', 'Vegetable Curry'];

    expect(await search(restaurant, 'Veg')).toEqual(expected);
    expect(await search(restaurant, 'veg')).toEqual(expected);
    expect(await search(restaurant, 'VEG')).toEqual(expected);
    expect(await search(restaurant, 'vEg')).toEqual(expected);
  });

  it('handles a hyphenated tag, which case-variant generation could not', async () => {
    // Title-casing "gluten-free" yields "Gluten-free", not the stored
    // "Gluten-Free" — the reason the fix resolves real spellings from the
    // data instead of guessing them.
    const expected = ['Papadam'];

    expect(await search(restaurant, 'Gluten-Free')).toEqual(expected);
    expect(await search(restaurant, 'gluten-free')).toEqual(expected);
    expect(await search(restaurant, 'GLUTEN-FREE')).toEqual(expected);
  });
});

describe('the match stays an equality, not a substring', () => {
  it('does not match a prefix of a tag', async () => {
    // "ve" is a prefix of the "Veg" tag. It must find only the row whose NAME
    // contains it — if the tag clause had loosened to a `contains`, Garden
    // Salad and Papadam would appear here too.
    expect(await search(restaurant, 've')).toEqual(['Vegetable Curry']);
  });

  it('does not match a tag that merely starts with the term plus more', async () => {
    await makeProduct(restaurant, 'Nut Roast', 'TS-NUT', ['Vegan']);

    // "Veg" and "Vegan" are different tags. Searching one must not drag in the
    // other, or a cashier filtering for vegetarian food would be shown vegan-
    // only items and vice versa.
    expect(await search(restaurant, 'veg')).toEqual([
      'Garden Salad',
      'Papadam',
      'Vegetable Curry',
    ]);
    expect(await search(restaurant, 'vegan')).toEqual(['Nut Roast']);
  });

  it('returns nothing for a term that is neither a tag nor in a name', async () => {
    expect(await search(restaurant, 'halal')).toEqual([]);
  });
});

describe('tenant isolation', () => {
  it('never resolves a spelling from another tenant', async () => {
    // The other tenant stores the tag in a different case. Resolving spellings
    // tenant-wide instead of per-tenant would let this row's casing satisfy
    // the first tenant's search — and, worse, leak that the tag exists.
    await makeProduct(other, 'Other Salad', 'OT-SALAD', ['VEGAN']);

    expect(await search(restaurant, 'vegan')).toEqual([]);
    // Positive control: the other tenant really does have the row, so the
    // empty result above is isolation, not an empty database.
    expect(await search(other, 'vegan')).toEqual(['Other Salad']);
  });
});
