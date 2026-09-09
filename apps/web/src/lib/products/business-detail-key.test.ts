import { describe, expect, it } from 'vitest';

import {
  BUSINESS_DETAIL_KEY_PATTERN,
  keyFromLabel,
  uniqueKeyFromLabel,
} from './business-detail-key';

/**
 * D138 — the label→key derivation.
 *
 * ## What makes these assertions non-vacuous
 *
 * The interesting property is not "Material becomes material" — that holds for
 * `toLowerCase`. It is that EVERY label a person can type produces a key the
 * server's pattern accepts, including the ones that produce nothing usable on
 * their own. So the pattern is asserted against every case here rather than a
 * hand-picked expected string being asserted alone, and the pattern itself is
 * proven to reject before it is used to accept — a regex that matched anything
 * would make every one of these pass.
 *
 * The uniqueness cases pair a collision with a non-collision, because a
 * suffixer that appended `2` unconditionally would satisfy the collision case
 * by itself and would rename every field on every save.
 */

describe('BUSINESS_DETAIL_KEY_PATTERN', () => {
  it('accepts the shape the server accepts and rejects the shapes it refuses', () => {
    // POSITIVE.
    for (const ok of ['material', 'careInstructions', 'a', 'x1', 'field2026Season']) {
      expect(BUSINESS_DETAIL_KEY_PATTERN.test(ok), ok).toBe(true);
    }
    // NEGATIVE — leading capital, leading digit, punctuation, spaces, empty.
    // Without these the pattern could be /.*/ and everything below would pass.
    for (const bad of ['Material', '2season', 'care_instructions', 'care instructions', '']) {
      expect(BUSINESS_DETAIL_KEY_PATTERN.test(bad), bad).toBe(false);
    }
  });
});

describe('keyFromLabel', () => {
  it('camel-cases the words of an ordinary label', () => {
    expect(keyFromLabel('Material')).toBe('material');
    expect(keyFromLabel('Care instructions')).toBe('careInstructions');
    expect(keyFromLabel('Size (cm)')).toBe('sizeCm');
    expect(keyFromLabel('  Launch   date  ')).toBe('launchDate');
  });

  it('never returns a key the server would refuse, whatever is typed', () => {
    /*
     * The labels that have no natural key. Each is asserted against the PATTERN
     * rather than against a string somebody wrote down here, because the
     * property that matters is "the round trip cannot fail", not "the fallback
     * happens to spell it this way".
     */
    const awkward = [
      '',
      '   ',
      '!!!',
      '2026 Season',
      '3D',
      '— dash only —',
      'Ω',
      '日本語',
      '99',
    ];
    for (const label of awkward) {
      const key = keyFromLabel(label);
      expect(BUSINESS_DETAIL_KEY_PATTERN.test(key), `${label} -> ${key}`).toBe(true);
    }
    // …and the fallback is a prefix, not a constant: two different awkward
    // labels must not collapse onto one key, which would silently merge two
    // fields' values on the product.
    expect(keyFromLabel('2026 Season')).not.toBe(keyFromLabel('3D'));
  });

  it('is stable: the same label always gives the same key', () => {
    // The property a rename depends on. If this ever drifted, editing a label
    // would silently re-key the field and orphan every stored value.
    expect(keyFromLabel('Care instructions')).toBe(keyFromLabel('Care instructions'));
  });
});

describe('uniqueKeyFromLabel', () => {
  it('returns the natural key when nothing has taken it', () => {
    // POSITIVE, and the half that proves the suffixer is not unconditional.
    expect(uniqueKeyFromLabel('Material', [])).toBe('material');
    expect(uniqueKeyFromLabel('Material', ['fit', 'season'])).toBe('material');
  });

  it('suffixes only on a real collision, and keeps counting', () => {
    expect(uniqueKeyFromLabel('Material', ['material'])).toBe('material2');
    expect(uniqueKeyFromLabel('Material', ['material', 'material2'])).toBe('material3');
    // Two labels that collapse to one key is an ordinary thing to type.
    expect(uniqueKeyFromLabel('Care Instructions', ['careInstructions'])).toBe(
      'careInstructions2',
    );
  });

  it('produces a valid key even when the collision is on a fallback', () => {
    const first = uniqueKeyFromLabel('2026 Season', []);
    const second = uniqueKeyFromLabel('2026 Season', [first]);
    expect(first).not.toBe(second);
    for (const key of [first, second]) {
      expect(BUSINESS_DETAIL_KEY_PATTERN.test(key), key).toBe(true);
    }
  });
});
