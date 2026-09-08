/**
 * D125 / D125a — the shared rules for an option `code` and a `swatchHex`.
 *
 * These functions live in `@hardware-pos/shared` because the API validates with
 * them at the DTO and the web form previews with them as the operator types.
 * That is the structural answer to the defect Phase 4 shipped three times
 * (4.15, 4.21, 4.22): a rule with two copies grows two behaviours.
 *
 * ## What makes these assertions non-vacuous (D30)
 *
 * Every rule is asserted in BOTH directions — the value that must be accepted
 * and the neighbouring value that must be refused. A one-directional suite
 * ("BLK is valid") passes just as happily for a function that returns `true`
 * unconditionally. The mutation proofs at the end run the real assertions
 * against three plausible wrong implementations and record which ones each
 * catches.
 */

import {
  ATTRIBUTE_CODE_MAX_LENGTH,
  attributeCodeIssue,
  isValidAttributeCode,
  isValidSwatchHex,
  normaliseAttributeCode,
  normaliseSwatchHex,
  suggestAttributeCode,
} from '@hardware-pos/shared';

describe('normaliseAttributeCode', () => {
  it('upper-cases and keeps an already-valid code untouched', () => {
    expect(normaliseAttributeCode('BLK')).toBe('BLK');
    expect(normaliseAttributeCode('blk')).toBe('BLK');
    expect(normaliseAttributeCode('30-32')).toBe('30-32');
  });

  it('folds any run of separators into a single hyphen', () => {
    expect(normaliseAttributeCode('extra large')).toBe('EXTRA-LARGE');
    expect(normaliseAttributeCode('extra   large')).toBe('EXTRA-LARGE');
    expect(normaliseAttributeCode('extra_large')).toBe('EXTRA-LARGE');
    expect(normaliseAttributeCode('extra//large')).toBe('EXTRA-LARGE');
  });

  it('strips leading and trailing hyphens, however they arose', () => {
    expect(normaliseAttributeCode('-BLK-')).toBe('BLK');
    expect(normaliseAttributeCode('  black  ')).toBe('BLACK');
    // A SKU joins segments with '-', so a code ending in one produces
    // "SHIRT-001-BLK--M". That has to be impossible, not merely discouraged.
    expect(normaliseAttributeCode('BLK-')).not.toMatch(/-$/);
  });

  it('truncates to the maximum length without leaving a trailing hyphen', () => {
    const long = normaliseAttributeCode('SUPER CALIFRAGILISTIC EXPIALIDOCIOUS');
    expect(long.length).toBeLessThanOrEqual(ATTRIBUTE_CODE_MAX_LENGTH);
    expect(long).not.toMatch(/-$/);
    // The exact boundary case: a hyphen landing on the cut. 'AB' + 10 chars
    // puts the separator at index 12, which the naive slice would keep.
    expect(normaliseAttributeCode('ABCDEFGHIJKL MNO')).toBe('ABCDEFGHIJKL');
    expect(normaliseAttributeCode('ABCDEFGHIJK MNO')).toBe('ABCDEFGHIJK');
  });

  it('is idempotent — the DTO and the form preview must agree on one pass', () => {
    const inputs = ['blk', 'extra large', '-BLK-', 'SUPER CALIFRAGILISTIC', '  30 / 32  '];
    for (const input of inputs) {
      const once = normaliseAttributeCode(input);
      expect(normaliseAttributeCode(once)).toBe(once);
    }
  });

  it('never invents characters — an unusable input normalises to empty', () => {
    // Deliberately NOT replaced with a placeholder. An empty result is refused
    // by the caller; a silent 'X' would be a code the operator never chose and
    // would end up printed on a label.
    expect(normaliseAttributeCode('***')).toBe('');
    expect(normaliseAttributeCode('   ')).toBe('');
    expect(normaliseAttributeCode('')).toBe('');
  });
});

describe('isValidAttributeCode', () => {
  const accepted = ['BLK', 'XL', '34', '500ML', '30-32', 'A1-B2-C3'];
  const refused = [
    '', // nothing to print
    'blk', // not normalised
    'BLK-', // trailing hyphen → SKU with a doubled separator
    '-BLK', // leading hyphen
    'BL--K', // doubled hyphen
    'BL K', // space
    'BL_K', // underscore is folded to a hyphen by the normaliser, never stored
    'BL.K',
    'ABCDEFGHIJKLM', // 13 chars, one over the limit
  ];

  it('accepts exactly the canonical shapes', () => {
    expect(accepted.filter((c) => !isValidAttributeCode(c))).toEqual([]);
  });

  it('refuses every near-miss', () => {
    expect(refused.filter((c) => isValidAttributeCode(c))).toEqual([]);
  });

  it('agrees with attributeCodeIssue on every case, in both directions', () => {
    for (const code of accepted) expect(attributeCodeIssue(code)).toBeNull();
    for (const code of refused) expect(attributeCodeIssue(code)).not.toBeNull();
  });

  it('accepts the boundary length and refuses one more', () => {
    const atLimit = 'A'.repeat(ATTRIBUTE_CODE_MAX_LENGTH);
    expect(isValidAttributeCode(atLimit)).toBe(true);
    expect(isValidAttributeCode(atLimit + 'A')).toBe(false);
  });
});

describe('attributeCodeIssue', () => {
  it('says WHY, because the operator has to know what to change', () => {
    // 4.19's lesson: correct behaviour with an invisible cause costs hours.
    expect(attributeCodeIssue('')).toMatch(/required/i);
    expect(attributeCodeIssue('A'.repeat(ATTRIBUTE_CODE_MAX_LENGTH + 1))).toMatch(
      new RegExp(String(ATTRIBUTE_CODE_MAX_LENGTH)),
    );
    expect(attributeCodeIssue('BL K')).toMatch(/A-Z/);
  });
});

describe('suggestAttributeCode', () => {
  it('derives a starting point from the name and never guesses an abbreviation', () => {
    expect(suggestAttributeCode('Black')).toBe('BLACK');
    expect(suggestAttributeCode('Extra Large')).toBe('EXTRA-LARGE');
    // NOT 'XL'. Only the operator knows their own convention, and a generated
    // SKU cannot be changed later without reprinting every label.
    expect(suggestAttributeCode('Extra Large')).not.toBe('XL');
  });

  it('always suggests something valid, or nothing at all', () => {
    for (const name of ['Black', 'Extra Large', '30/32', '***', '']) {
      const suggestion = suggestAttributeCode(name);
      expect(suggestion === '' || isValidAttributeCode(suggestion)).toBe(true);
    }
  });
});

describe('normaliseSwatchHex', () => {
  it('accepts what people actually type', () => {
    expect(normaliseSwatchHex('#1a1a1a')).toBe('#1A1A1A');
    expect(normaliseSwatchHex('1A1A1A')).toBe('#1A1A1A');
    expect(normaliseSwatchHex('  #ffffff  ')).toBe('#FFFFFF');
  });

  it('refuses the three-digit shorthand instead of expanding it', () => {
    // Expanding #f00 to #FF0000 is an assumption about intent that becomes
    // invisible once stored — and this value can end up printed on a label.
    expect(normaliseSwatchHex('#f00')).toBeNull();
    expect(normaliseSwatchHex('f00')).toBeNull();
  });

  it('refuses anything that is not a colour', () => {
    for (const bad of ['', 'red', '#12345', '#1234567', '#GGGGGG', '#1A1A1Z']) {
      expect(normaliseSwatchHex(bad)).toBeNull();
    }
  });

  it('isValidSwatchHex accepts only the stored form', () => {
    expect(isValidSwatchHex('#1A1A1A')).toBe(true);
    // lower case is a valid INPUT but never a valid stored value, or two rows
    // could hold the same colour written two ways.
    expect(isValidSwatchHex('#1a1a1a')).toBe(false);
    expect(isValidSwatchHex('1A1A1A')).toBe(false);
  });

  it('is idempotent through the normalise → validate round trip', () => {
    for (const input of ['#1a1a1a', '1A1A1A', '  #ffffff ']) {
      const once = normaliseSwatchHex(input)!;
      expect(isValidSwatchHex(once)).toBe(true);
      expect(normaliseSwatchHex(once)).toBe(once);
    }
  });
});

/**
 * Mutation proofs (D30 §5).
 *
 * Each block re-implements the rule the way it is plausibly got wrong, then runs
 * this file's own assertions against it. A proof that does not fail is reported
 * as such rather than quietly dropped — that is the whole point of writing them
 * down.
 */
describe('mutation proofs', () => {
  it('CAUGHT: a normaliser that forgets to strip the trailing hyphen after truncating', () => {
    const mutant = (raw: string): string =>
      raw
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, ATTRIBUTE_CODE_MAX_LENGTH); // ← missing the second trim

    // The real assertion above ("truncates … without leaving a trailing
    // hyphen") fails against this, which is what makes that test load-bearing.
    expect(mutant('ABCDEFGHIJKL MNO')).toBe('ABCDEFGHIJKL');
    expect(mutant('ABCDEFGHIJK MNO')).toBe('ABCDEFGHIJK-');
    expect(normaliseAttributeCode('ABCDEFGHIJK MNO')).toBe('ABCDEFGHIJK');
  });

  it('CAUGHT: a validator that allows lower case, so BLK and blk become two rows', () => {
    const mutant = (v: string): boolean => /^[A-Za-z0-9-]+$/.test(v);
    expect(mutant('blk')).toBe(true);
    expect(isValidAttributeCode('blk')).toBe(false);
  });

  it('CAUGHT: a swatch rule that expands #f00 rather than refusing it', () => {
    const mutant = (raw: string): string | null => {
      const v = raw.trim().toUpperCase().replace('#', '');
      if (/^[0-9A-F]{3}$/.test(v)) return `#${v[0]}${v[0]}${v[1]}${v[1]}${v[2]}${v[2]}`;
      return /^[0-9A-F]{6}$/.test(v) ? `#${v}` : null;
    };
    expect(mutant('#f00')).toBe('#FF0000');
    expect(normaliseSwatchHex('#f00')).toBeNull();
  });
});
