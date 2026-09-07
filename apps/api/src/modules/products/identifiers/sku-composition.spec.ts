/**
 * D104 — option-code resolution (`5.2`) and SKU composition (`5.3`).
 *
 * Both are pure, so they are exhaustively testable without a database. The
 * allocation half — `DocumentSequence`, collision retry, gaps — is a
 * transactional concern and is proven in the integration spec instead. That
 * split is deliberate: a mocked sequence would prove nothing about concurrency,
 * and a database is not needed to prove that `BLK` + `M` join with a hyphen.
 *
 * ## What makes these assertions non-vacuous (D30)
 *
 * The LIBRARY and DERIVED paths are asserted against each other rather than
 * separately — the whole value of the library is that two differently-spelled
 * dimensions produce the SAME segment, so that equality is asserted directly,
 * alongside the inequality that holds when they are unmapped. The mutation
 * proofs run the real assertions against the two shortcuts a reasonable
 * implementation would take.
 */

import {
  SKU_CATEGORY_SEGMENT_MAX,
  SKU_DEFAULT_CATEGORY_SEGMENT,
  composeSku,
  isFullyMapped,
  resolveOptionCode,
  resolveOptionCodes,
  skuCategorySegment,
} from '@hardware-pos/shared';

describe('resolveOptionCode', () => {
  it('prefers the library code and says so', () => {
    expect(resolveOptionCode({ name: 'Black', libraryCode: 'BLK' })).toEqual({
      code: 'BLK',
      source: 'LIBRARY',
    });
  });

  it('falls back to the option name and says THAT', () => {
    expect(resolveOptionCode({ name: 'Black', libraryCode: null })).toEqual({
      code: 'BLACK',
      source: 'DERIVED',
    });
    // The caller must be able to tell the two apart — a screen says "this
    // segment will change if you rename the option" only for DERIVED.
    expect(resolveOptionCode({ name: 'Black' })!.source).toBe('DERIVED');
  });

  it('is why the library exists: two spellings, one segment', () => {
    // `Colour :: Black` and `Color :: Black`, both mapped to the same library
    // option. This equality is the entire argument for D104.
    const colour = resolveOptionCode({ name: 'Black', libraryCode: 'BLK' });
    const color = resolveOptionCode({ name: 'Black ', libraryCode: 'BLK' });
    expect(colour!.code).toBe(color!.code);

    // Unmapped, the same two rows can drift apart the moment either is renamed.
    const unmappedA = resolveOptionCode({ name: 'Black', libraryCode: null });
    const unmappedB = resolveOptionCode({ name: 'Jet Black', libraryCode: null });
    expect(unmappedA!.code).not.toBe(unmappedB!.code);
  });

  it('returns null rather than inventing a placeholder', () => {
    // A character nobody chose, printed on a label, is worse than a refusal.
    expect(resolveOptionCode({ name: '///', libraryCode: null })).toBeNull();
    expect(resolveOptionCode({ name: '', libraryCode: null })).toBeNull();
    // An empty-string library code is treated as absent, not as a valid code.
    expect(resolveOptionCode({ name: 'Black', libraryCode: '' })).toEqual({
      code: 'BLACK',
      source: 'DERIVED',
    });
  });
});

describe('resolveOptionCodes', () => {
  it('keeps the given order — it is the product’s dimension order', () => {
    const resolved = resolveOptionCodes([
      { name: 'Black', libraryCode: 'BLK' },
      { name: 'Medium', libraryCode: 'M' },
    ]);
    expect(resolved!.map((r) => r.code)).toEqual(['BLK', 'M']);
  });

  it('returns null when ANY option fails, never a partial list', () => {
    // A SKU missing one axis is not a shorter SKU, it is a DIFFERENT
    // identifier: `SHIRT-0001-BLK` meaning "black, size unknown" would collide
    // with a genuine single-axis variant.
    expect(
      resolveOptionCodes([
        { name: 'Black', libraryCode: 'BLK' },
        { name: '///', libraryCode: null },
      ]),
    ).toBeNull();
  });

  it('isFullyMapped is true only when every segment came from the library', () => {
    const all = resolveOptionCodes([
      { name: 'Black', libraryCode: 'BLK' },
      { name: 'Medium', libraryCode: 'M' },
    ])!;
    const mixed = resolveOptionCodes([
      { name: 'Black', libraryCode: 'BLK' },
      { name: 'Medium', libraryCode: null },
    ])!;
    expect(isFullyMapped(all)).toBe(true);
    expect(isFullyMapped(mixed)).toBe(false);
    // An empty list is not "fully mapped" — there is nothing to be stable.
    expect(isFullyMapped([])).toBe(false);
  });
});

describe('skuCategorySegment', () => {
  it('folds a category name and caps its width', () => {
    expect(skuCategorySegment('Apparel')).toBe('APPAREL');
    expect(skuCategorySegment('Ladies Footwear')).toBe('LADIES-F'.slice(0, SKU_CATEGORY_SEGMENT_MAX));
    expect(skuCategorySegment('Apparel')!.length).toBeLessThanOrEqual(SKU_CATEGORY_SEGMENT_MAX);
  });

  it('never ends in a hyphen, however the cap falls', () => {
    // 'LADIES ' cut at 8 would be 'LADIES-', which composes to 'LADIES--0001'.
    for (const name of ['Ladies Footwear', 'Men Shirts', 'A B C D E F G H']) {
      expect(skuCategorySegment(name)).not.toMatch(/-$/);
    }
  });

  it('falls back for a product with no category, or an unusable one', () => {
    expect(skuCategorySegment(null)).toBe(SKU_DEFAULT_CATEGORY_SEGMENT);
    expect(skuCategorySegment(undefined)).toBe(SKU_DEFAULT_CATEGORY_SEGMENT);
    expect(skuCategorySegment('')).toBe(SKU_DEFAULT_CATEGORY_SEGMENT);
    expect(skuCategorySegment('///')).toBe(SKU_DEFAULT_CATEGORY_SEGMENT);
  });
});

describe('composeSku', () => {
  it('builds <CATEGORY>-<SEQ>-<OPTIONS…>', () => {
    expect(
      composeSku({ categorySegment: 'APPAREL', sequence: 7, optionCodes: ['BLK', 'M'] }),
    ).toBe('APPAREL-0007-BLK-M');
  });

  it('pads the sequence and widens past the pad rather than truncating', () => {
    expect(composeSku({ categorySegment: 'GEN', sequence: 1, optionCodes: [] })).toBe('GEN-0001');
    // 10,000th product: the identifier gets longer, it does not wrap. A wrapped
    // sequence would reissue an identifier that is already on a printed label.
    expect(composeSku({ categorySegment: 'GEN', sequence: 12345, optionCodes: [] })).toBe(
      'GEN-12345',
    );
  });

  it('omits the option section entirely for a variant with no axes', () => {
    expect(composeSku({ categorySegment: 'GEN', sequence: 3, optionCodes: [] })).toBe('GEN-0003');
    expect(composeSku({ categorySegment: 'GEN', sequence: 3, optionCodes: [] })).not.toMatch(/-$/);
  });

  it('never produces a doubled separator from any valid input', () => {
    const skus = [
      composeSku({ categorySegment: skuCategorySegment('Ladies Footwear'), sequence: 1, optionCodes: ['BLK'] }),
      composeSku({ categorySegment: skuCategorySegment(null), sequence: 99, optionCodes: [] }),
      composeSku({ categorySegment: 'APPAREL', sequence: 1, optionCodes: ['30-32', 'BLK'] }),
    ];
    for (const sku of skus) {
      expect(sku).not.toMatch(/--/);
      expect(sku).not.toMatch(/^-|-$/);
    }
  });
});

/**
 * Mutation proofs (D30 §5).
 */
describe('mutation proofs', () => {
  it('CAUGHT: a category segment that truncates without re-trimming the hyphen', () => {
    const mutant = (name: string): string =>
      name
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, '-')
        .slice(0, SKU_CATEGORY_SEGMENT_MAX);

    expect(mutant('Ladies Footwear')).toBe('LADIES-F');
    expect(mutant('Men Shirts')).toBe('MEN-SHIR');
    // The failing shape: a name whose cut lands exactly on the separator.
    expect(mutant('A B C D E')).toMatch(/-$/);
    expect(skuCategorySegment('A B C D E')).not.toMatch(/-$/);
  });

  it('CAUGHT: resolveOptionCodes returning a partial list instead of null', () => {
    const mutant = (options: Array<{ name: string; libraryCode: string | null }>) =>
      options.map((o) => resolveOptionCode(o)).filter((r) => r !== null);

    const input = [
      { name: 'Black', libraryCode: 'BLK' },
      { name: '///', libraryCode: null },
    ];
    // The mutant silently drops the unusable axis and yields a one-axis SKU
    // that can collide with a genuine one.
    expect(mutant(input)).toHaveLength(1);
    expect(resolveOptionCodes(input)).toBeNull();
  });

  it('NOT CAUGHT by these tests: a sequence shared across a batch', () => {
    // Recorded honestly. `composeSku` is given a number; it cannot tell whether
    // the caller allocated one per variant or reused one across a batch. The
    // per-variant allocation is asserted in the integration spec, where the
    // sequence actually moves — there is nothing to assert about it here.
    expect(composeSku({ categorySegment: 'A', sequence: 1, optionCodes: ['S'] })).toBe('A-0001-S');
    expect(composeSku({ categorySegment: 'A', sequence: 1, optionCodes: ['M'] })).toBe('A-0001-M');
  });
});
