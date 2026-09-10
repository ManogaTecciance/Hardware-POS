/**
 * D169 — the catalogue label resolvers.
 *
 * ## What makes these assertions non-vacuous (D30)
 *
 * Every "loading" and "error" case is paired with the assertion that the answer
 * is NOT `—`. That pairing is the whole point: `—` is what the card shows for a
 * fact that is genuinely absent, so returning it while a catalogue is in flight
 * would not look broken — it would look like a product with no category. That
 * is the D167 bug exactly, and a test that only checked "it says something"
 * would pass straight through it.
 *
 * The three states are asserted against the SAME product, so a resolver that
 * had stopped consulting `state` at all fails more than one of them rather than
 * passing whichever was checked alone. And each state is checked against a
 * product that HAS an id and one that does not, because the short-circuit for
 * "no category" is a separate decision from the wait.
 *
 * `businessDetailRows` is asserted with `toEqual` on the whole array — an exact
 * set in an exact order. A row added, dropped, relabelled or reordered all fail
 * here; a length check would catch none of those.
 */
import { describe, expect, it } from 'vitest';

import type { AttributeField } from '@hardware-pos/shared';

import type { CategoryNode } from '../products-api';
import {
  brandLabel,
  businessDetailRows,
  categoryLabel,
  humaniseKey,
  type Lookup,
} from './catalogue-labels';
import type { Brand } from './brands-api';

const DASH = '—';

const category = (over: Partial<CategoryNode> = {}): CategoryNode =>
  ({
    id: 'cat_1',
    name: 'Building Materials',
    slug: 'building-materials',
    description: null,
    imageUrl: null,
    sortOrder: 0,
    isActive: true,
    quickbooksItemId: null,
    subcategories: [],
    ...over,
  }) as CategoryNode;

const brand = (over: Partial<Brand> = {}): Brand => ({
  id: 'brd_1',
  name: 'Tokyo Cement',
  isActive: true,
  productCount: 3,
  ...over,
});

const ready = <T,>(rows: T[]): Lookup<T> => ({ state: 'ready', rows });
const loading = <T,>(): Lookup<T> => ({ state: 'loading', rows: [] });
const failed = <T,>(): Lookup<T> => ({ state: 'error', rows: [] });

describe('D169 — categoryLabel', () => {
  const withCategory = { categoryId: 'cat_1', subcategoryId: null };
  const uncategorised = { categoryId: null, subcategoryId: null };

  it('answers "no category" instantly, without waiting for a catalogue', () => {
    /*
     * The short-circuit. `categoryId` arrives WITH the product and is
     * authoritative, so a product that has no category must not sit on
     * "Loading…" while a list it does not need is fetched. D167 fixed the
     * opposite error one screen over; this is the guard against overcorrecting
     * into a slow answer where an instant true one exists.
     */
    expect(categoryLabel(uncategorised, loading())).toBe(DASH);
    expect(categoryLabel(uncategorised, failed())).toBe(DASH);
    expect(categoryLabel(uncategorised, ready([category()]))).toBe(DASH);
  });

  it('waits, rather than claiming the product has no category', () => {
    const label = categoryLabel(withCategory, loading());

    expect(label).toBe('Loading…');
    // The half that matters. `—` here would be indistinguishable from the
    // uncategorised case above, and would be a wrong fact rather than a
    // missing one.
    expect(label).not.toBe(DASH);
  });

  it('says a failure was a failure', () => {
    const label = categoryLabel(withCategory, failed());

    expect(label).toBe('Could not be loaded');
    expect(label).not.toBe(DASH);
    expect(label).not.toBe('Loading…');
  });

  it('names the category once the catalogue lands', () => {
    expect(categoryLabel(withCategory, ready([category()]))).toBe('Building Materials');
  });

  it('names the subcategory under its parent, as one fact', () => {
    const rows = [
      category({
        subcategories: [{ id: 'sub_1', categoryId: 'cat_1', name: 'Cement' }],
      } as Partial<CategoryNode>),
    ];

    expect(
      categoryLabel({ categoryId: 'cat_1', subcategoryId: 'sub_1' }, ready(rows)),
    ).toBe('Building Materials › Cement');
  });

  it('falls back to the parent when only the subcategory is unknown', () => {
    // The category is still true and still worth showing. Reporting the whole
    // pair as dangling would throw away a fact we hold.
    expect(
      categoryLabel({ categoryId: 'cat_1', subcategoryId: 'sub_gone' }, ready([category()])),
    ).toBe('Building Materials');
  });

  it('says so when the id is not in the catalogue at all', () => {
    const label = categoryLabel({ categoryId: 'cat_gone', subcategoryId: null }, ready([category()]));

    expect(label).toBe('No longer in the catalogue');
    // NOT `—`: the product HAS a category. We simply cannot name it, which is
    // a different thing from not having one.
    expect(label).not.toBe(DASH);
  });
});

describe('D169 — brandLabel', () => {
  it('answers instantly for a product with no brand', () => {
    // Both spellings of absent: the field is optional on the type, so a payload
    // that predates the declaration arrives as `undefined`, not `null`.
    expect(brandLabel({ brandId: null }, loading())).toBe(DASH);
    expect(brandLabel({}, loading())).toBe(DASH);
  });

  it('waits and reports failure for a product that has one', () => {
    expect(brandLabel({ brandId: 'brd_1' }, loading())).toBe('Loading…');
    expect(brandLabel({ brandId: 'brd_1' }, failed())).toBe('Could not be loaded');
    expect(brandLabel({ brandId: 'brd_1' }, loading())).not.toBe(DASH);
  });

  it('names the brand, and says so when it is gone', () => {
    expect(brandLabel({ brandId: 'brd_1' }, ready([brand()]))).toBe('Tokyo Cement');
    expect(brandLabel({ brandId: 'brd_gone' }, ready([brand()]))).toBe('No longer in the catalogue');
  });
});

describe('D169 — humaniseKey', () => {
  it('reads a stored key as words', () => {
    // An exact map, not a spot check: each input exercises a different
    // separator, and a resolver that handled only one of them would pass a
    // single-case test.
    expect(
      ['warrantyMonths', 'grade_code', 'thread-size', 'voltage', 'isoRating9001'].map(humaniseKey),
    ).toEqual(['Warranty months', 'Grade code', 'Thread size', 'Voltage', 'Iso rating9001']);
  });
});

describe('D169 — businessDetailRows', () => {
  const fields: AttributeField[] = [
    { key: 'material', label: 'Material', type: 'text' },
    { key: 'warrantyMonths', label: 'Warranty (months)', type: 'integer' },
    { key: 'weatherproof', label: 'Weatherproof', type: 'boolean' },
  ];

  it('renders the tenant’s own labels, in the tenant’s own order', () => {
    const rows = businessDetailRows(
      // Deliberately the WRONG order in the document, so an implementation
      // that walked `Object.entries` and ignored the schema fails here.
      { weatherproof: true, material: 'Galvanised steel', warrantyMonths: 24 },
      fields,
    );

    expect(rows).toEqual([
      { key: 'material', label: 'Material', value: 'Galvanised steel' },
      { key: 'warrantyMonths', label: 'Warranty (months)', value: '24' },
      { key: 'weatherproof', label: 'Weatherproof', value: 'Yes' },
    ]);
  });

  it('renders false as "No" rather than dropping it', () => {
    /*
     * `false` is a fact — "this product is NOT weatherproof" is exactly what a
     * customer asks. It is also the value that vanishes silently from JSX and
     * from any truthiness filter, which is why it is asserted on its own.
     */
    expect(businessDetailRows({ weatherproof: false }, fields)).toEqual([
      { key: 'weatherproof', label: 'Weatherproof', value: 'No' },
    ]);
  });

  it('drops fields nobody filled in, and keeps the ones somebody did', () => {
    const rows = businessDetailRows(
      { material: '', warrantyMonths: null, weatherproof: true },
      fields,
    );

    // POSITIVE — the one real value survives…
    expect(rows).toEqual([{ key: 'weatherproof', label: 'Weatherproof', value: 'Yes' }]);
    // …NEGATIVE — and neither empty field became a blank row. An exact-array
    // assertion states both at once, but they are named here because "renders
    // an empty row" is the failure a reader should picture.
    expect(rows.map((r) => r.key)).not.toContain('material');
    expect(rows.map((r) => r.key)).not.toContain('warrantyMonths');
  });

  it('keeps values whose field the tenant has since removed', () => {
    /*
     * D161 lets a tenant REPLACE their business-details list. Products created
     * under the old list still carry the old values, and hiding them would
     * silently lose data an operator typed in. They follow the schema fields,
     * humanised, because there is no tenant label left to use.
     */
    const rows = businessDetailRows({ material: 'Brass', threadSize: 'M8' }, fields);

    expect(rows).toEqual([
      { key: 'material', label: 'Material', value: 'Brass' },
      { key: 'threadSize', label: 'Thread size', value: 'M8' },
    ]);
  });

  it('is empty when there is nothing to say', () => {
    // The card is hidden on this answer, so an implementation that returned a
    // placeholder row instead would put an empty card on every product.
    expect(businessDetailRows({}, fields)).toEqual([]);
    expect(businessDetailRows({ material: '   ' }, fields)).toEqual([]);
  });

  it('works with no schema at all, which is what hardware has', () => {
    /*
     * `GET /products/attribute-schema` answers `{fields: []}` for a vertical
     * that declares none (verified live). A product carrying attributes from
     * an import must still render, or the schema's emptiness would erase them.
     */
    expect(businessDetailRows({ gradeCode: 'A1' }, [])).toEqual([
      { key: 'gradeCode', label: 'Grade code', value: 'A1' },
    ]);
  });
});
