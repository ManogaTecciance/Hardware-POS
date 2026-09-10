/**
 * D169 — turning the IDs on a product into the words an operator reads.
 *
 * The product payload carries `categoryId`, `subcategoryId` and `brandId`, and
 * an `attributes` document keyed by opaque strings. None of those are readable.
 * The names live in per-tenant catalogues fetched separately, so every answer
 * here has three moments, not two: not asked yet, asked and answered, asked and
 * failed.
 *
 * That distinction is the whole reason this file exists as pure functions. D167
 * was a bug of exactly this shape one screen over — an empty array that had not
 * been filled yet was read as fact, and the page confidently described a
 * product it knew nothing about. The rule that came out of it holds here:
 *
 *   the ID is authoritative and arrives WITH the product;
 *   only the NAME needs the catalogue, so only the name waits.
 *
 * A product with no `categoryId` is uncategorised, and says so instantly. A
 * product WITH one says "Loading…" until the catalogue lands, and "Could not be
 * loaded" if it never does — never "—", which would read as "no category" and
 * be a different, wrong fact.
 */

import type { AttributeField } from '@hardware-pos/shared';

import type { CategoryNode } from '../products-api';
import type { Brand } from './brands-api';

/**
 * A catalogue fetch: what came back, and whether it is an ANSWER.
 *
 * `rows` is `[]` both before the request resolves and after it fails, which is
 * precisely why `state` cannot be inferred from it.
 */
export interface Lookup<T> {
  state: 'loading' | 'ready' | 'error';
  rows: T[];
}

/** The lookup a caller starts with, before anything has been asked. */
export const PENDING: Lookup<never> = { state: 'loading', rows: [] };

/** Shown where a fact is genuinely absent, as the rest of the card does. */
const NONE = '—';
const LOADING = 'Loading…';
const FAILED = 'Could not be loaded';

/**
 * Resolve a name from a catalogue, honouring the three states.
 *
 * `id === null` short-circuits BEFORE `state` is consulted: a product with no
 * category is uncategorised whether or not the catalogue ever arrives, and
 * making it wait would be the mirror of the D167 bug — a slow answer in place
 * of an instant true one.
 */
function resolve(id: string | null | undefined, lookup: Lookup<unknown>, name: () => string | null): string {
  if (!id) return NONE;
  if (lookup.state === 'loading') return LOADING;
  if (lookup.state === 'error') return FAILED;
  /*
   * Answered, and the ID is not in it. A dangling reference — an archived
   * brand, a category deleted while the page was open. Saying "—" here would
   * claim the product has no category, which is false: it has one, and we
   * cannot name it.
   */
  return name() ?? 'No longer in the catalogue';
}

/**
 * "Building Materials", or "Building Materials › Cement" where a subcategory
 * is set. One string rather than two facts: the subcategory is meaningless
 * without its parent, and two rows reading "Cement" under "Building Materials"
 * spends twice the space saying it.
 */
export function categoryLabel(
  product: { categoryId: string | null; subcategoryId: string | null },
  categories: Lookup<CategoryNode>,
): string {
  return resolve(product.categoryId, categories, () => {
    const cat = categories.rows.find((c) => c.id === product.categoryId);
    if (!cat) return null;
    if (!product.subcategoryId) return cat.name;
    const sub = cat.subcategories?.find((s) => s.id === product.subcategoryId);
    // A subcategory we cannot name still leaves the category true, so the
    // parent's name is a better answer than the dangling-reference wording.
    return sub ? `${cat.name} › ${sub.name}` : cat.name;
  });
}

export function brandLabel(
  product: { brandId?: string | null },
  brands: Lookup<Brand>,
): string {
  return resolve(product.brandId, brands, () => {
    const brand = brands.rows.find((b) => b.id === product.brandId);
    return brand ? brand.name : null;
  });
}

/** One line of the Business details card. */
export interface BusinessDetailRow {
  key: string;
  label: string;
  value: string;
}

/**
 * `warrantyMonths` → `Warranty months`. The fallback when the schema does not
 * describe a key, never the first choice: the tenant wrote a real label and
 * that is what they should read.
 */
export function humaniseKey(key: string): string {
  const spaced = key
    .replace(/[_-]+/g, ' ')
    // Sentence case, not title case: the split capital is lowered so this
    // reads like every other label on the card ("Track inventory", "Reorder
    // point"), rather than shouting "Warranty Months" beside them.
    .replace(/([a-z0-9])([A-Z])/g, (_m, a: string, b: string) => `${a} ${b.toLowerCase()}`)
    .trim();
  if (!spaced) return key;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * A stored attribute value as text.
 *
 * Booleans become Yes/No because `false` renders as nothing at all in JSX and
 * "false" reads like a string a machine left behind. Everything else is shown
 * as it was stored — a date is already `YYYY-MM-DD` (D64), and reformatting it
 * to a locale would be this file inventing a fact it was not given.
 */
function formatValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null;
  if (typeof value === 'string') return value.trim() === '' ? null : value;
  if (Array.isArray(value)) {
    const parts = value.map(formatValue).filter((v): v is string => v !== null);
    return parts.length ? parts.join(', ') : null;
  }
  return null;
}

/**
 * The rows to render for `product.attributes`, in the tenant's own order.
 *
 * Two rules, both deliberate:
 *
 * 1. **Schema order first, then leftovers.** A tenant may replace their
 *    business-details list (D161), and products created under the old list
 *    still carry those values. Rendering only what the schema names would hide
 *    real data the operator entered, so unknown keys follow, humanised.
 *
 * 2. **Empty values are dropped, not rendered blank.** A field nobody filled in
 *    is not a fact about the product; a row reading "Warranty:" with nothing
 *    after it is noise the operator has to read past every time.
 */
export function businessDetailRows(
  attributes: Record<string, unknown>,
  fields: AttributeField[],
): BusinessDetailRow[] {
  const rows: BusinessDetailRow[] = [];
  const taken = new Set<string>();

  for (const field of fields) {
    const value = formatValue(attributes[field.key]);
    taken.add(field.key);
    if (value !== null) rows.push({ key: field.key, label: field.label, value });
  }

  for (const [key, raw] of Object.entries(attributes)) {
    if (taken.has(key)) continue;
    const value = formatValue(raw);
    if (value !== null) rows.push({ key, label: humaniseKey(key), value });
  }

  return rows;
}
