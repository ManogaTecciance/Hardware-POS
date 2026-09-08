/**
 * D125 Part 3 — EAN-13 arithmetic, prefix rules and symbol encoding
 * (Phase 5, steps `5.4`, `5.5`, `5.7`, `5.9`).
 *
 * ## What makes these assertions non-vacuous (D30)
 *
 * The check-digit function is asserted against **published** EAN-13 codes whose
 * validity is not in question, and against the same codes deliberately
 * corrupted — a validator that returned `true` unconditionally, and one that
 * returned `false` unconditionally, both fail. That is the same procedure the
 * D125 investigation used before believing its own finding that 18 of the
 * pilot's 20 barcodes are invalid.
 *
 * The symbol encoder is proven by **round trip**: this file implements a
 * decoder from the published module tables and asserts that encoding then
 * decoding returns the original digits. Asserting a module string against a
 * hard-coded expected string would prove only that the encoder still does what
 * it did when the string was pasted — including if that was wrong.
 */

import {
  composeInStoreEan13,
  ean13CheckDigit,
  ean13PrefixIssue,
  encodeCode128,
  encodeEan13,
  isInStoreEan13Prefix,
  isValidEan13,
  looksLikeEan13,
  withEan13CheckDigit,
  barcodeSvg,
} from '@hardware-pos/shared';

/** Published EAN-13 codes. Their check digits are correct by construction. */
const PUBLISHED_VALID = [
  '5901234123457',
  '4006381333931',
  '9780306406157',
  '0075678164125',
];

/** The pilot's real barcodes, from the D125 investigation. */
const PILOT_INVALID = ['2001000000015', '2001000000022', '2990001000000'];
const PILOT_VALID = ['2990001000001'];

describe('ean13CheckDigit / isValidEan13', () => {
  it('accepts every published code', () => {
    expect(PUBLISHED_VALID.filter((c) => !isValidEan13(c))).toEqual([]);
  });

  it('rejects each published code with one digit corrupted', () => {
    // Change a payload digit and the check digit no longer matches. Nine of the
    // ten possible substitutions must fail; the tenth is the original.
    for (const code of PUBLISHED_VALID) {
      const corrupted = `${code.slice(0, 5)}${(Number(code[5]) + 1) % 10}${code.slice(6)}`;
      expect(corrupted).not.toBe(code);
      expect(isValidEan13(corrupted)).toBe(false);
    }
  });

  it('rejects each published code with its CHECK digit corrupted', () => {
    for (const code of PUBLISHED_VALID) {
      const wrong = `${code.slice(0, 12)}${(Number(code[12]) + 1) % 10}`;
      expect(isValidEan13(wrong)).toBe(false);
    }
  });

  it('reproduces the D125 finding on the real pilot data', () => {
    // This is the measurement the phase plan is built on, re-run as a test.
    expect(PILOT_INVALID.filter((c) => isValidEan13(c))).toEqual([]);
    expect(PILOT_VALID.filter((c) => !isValidEan13(c))).toEqual([]);
  });

  it('withEan13CheckDigit turns any 12-digit payload into a valid code', () => {
    for (const payload of ['200100000001', '299000100000', '000000000000', '999999999999']) {
      expect(isValidEan13(withEan13CheckDigit(payload))).toBe(true);
    }
  });

  it('throws on a payload it cannot compute, rather than returning a number', () => {
    // Returning a digit for an 11-digit input would produce exactly the silent
    // wrongness this module exists to prevent.
    for (const bad of ['', '1', '12345678901', '1234567890123', 'abcdefghijkl']) {
      expect(() => ean13CheckDigit(bad)).toThrow();
    }
  });

  it('separates SHAPE from VALIDITY — the rule a supplier code depends on', () => {
    expect(looksLikeEan13('2001000000015')).toBe(true);
    expect(isValidEan13('2001000000015')).toBe(false);
    // A CODE128 alphanumeric is not an EAN-13 and must never be judged as one.
    expect(looksLikeEan13('ABC-123-XYZ')).toBe(false);
    expect(looksLikeEan13('12345678901234')).toBe(false); // 14 digits
  });
});

describe('prefix rules', () => {
  it('accepts the GS1 in-store range and refuses everything else', () => {
    // `0201` belongs in ACCEPTED: GS1 restricts by the LEADING digits, and a
    // longer prefix starting `02` is still inside the in-store range. Listing
    // it as refused was my mistake, not the function's.
    const accepted = ['02', '20', '21', '2001', '2990', '299999', '0201'];
    const refused = ['00', '19', '30', '99', '1234', '0100', '3001'];
    expect(accepted.filter((p) => !isInStoreEan13Prefix(p))).toEqual([]);
    expect(refused.filter((p) => isInStoreEan13Prefix(p))).toEqual([]);
  });

  it('the pilot prefixes were always in the right range — the prefix was never the bug', () => {
    expect(isInStoreEan13Prefix('2001')).toBe(true);
    expect(isInStoreEan13Prefix('2990')).toBe(true);
  });

  it('explains a refusal rather than just refusing', () => {
    expect(ean13PrefixIssue('2001')).toBeNull();
    expect(ean13PrefixIssue('20a1')).toMatch(/digits/i);
    expect(ean13PrefixIssue('2')).toMatch(/2 and 6/);
    expect(ean13PrefixIssue('1234567')).toMatch(/2 and 6/);
    expect(ean13PrefixIssue('1234')).toMatch(/02 or 20-29/);
  });
});

describe('composeInStoreEan13', () => {
  it('fills the width between prefix and check digit', () => {
    const code = composeInStoreEan13('2001', 1)!;
    expect(code).toHaveLength(13);
    expect(code.startsWith('2001')).toBe(true);
    expect(isValidEan13(code)).toBe(true);
    expect(code).toBe('2001000000012');

    // The pilot's very first barcode is `2001000000015`. Same prefix, same
    // sequence, same twelve payload digits — and a different final digit. The
    // old generator was correct about everything except the one digit that
    // makes the symbol scannable, which is precisely why nothing looked wrong.
    expect('2001000000015'.slice(0, 12)).toBe(code.slice(0, 12));
    expect(isValidEan13('2001000000015')).toBe(false);
  });

  it('every allocation in a long run is valid and distinct', () => {
    const seen = new Set<string>();
    for (let i = 1; i <= 500; i += 1) {
      const code = composeInStoreEan13('2001', i)!;
      expect(isValidEan13(code)).toBe(true);
      seen.add(code);
    }
    expect(seen.size).toBe(500);
  });

  it('refuses rather than wrapping when the range is exhausted', () => {
    // A wrapped sequence would REISSUE a code already on a printed label.
    expect(composeInStoreEan13('200100', 999999)).not.toBeNull();
    expect(composeInStoreEan13('200100', 1000000)).toBeNull();
    expect(composeInStoreEan13('200100000000', 1)).toBeNull();
  });
});

// ── Symbol encoding, proven by decoding it back ─────────────────────────────

const L = ['0001101','0011001','0010011','0111101','0100011','0110001','0101111','0111011','0110111','0001011'];
const G = ['0100111','0110011','0011011','0100001','0011101','0111001','0000101','0010001','0001001','0010111'];
const R = L.map((p) => p.replace(/[01]/g, (b) => (b === '0' ? '1' : '0')));
const PARITY = ['LLLLLL','LLGLGG','LLGGLG','LLGGGL','LGLLGG','LGGLLG','LGGGLL','LGLGLG','LGLGGL','LGGLGL'];

/** Independent decoder, written from the published tables. */
function decodeEan13(modules: string): string | null {
  if (modules.length !== 95) return null;
  if (modules.slice(0, 3) !== '101') return null;
  if (modules.slice(45, 50) !== '01010') return null;
  if (modules.slice(92) !== '101') return null;

  let parity = '';
  const left: number[] = [];
  for (let i = 0; i < 6; i += 1) {
    const chunk = modules.slice(3 + i * 7, 10 + i * 7);
    const l = L.indexOf(chunk);
    const g = G.indexOf(chunk);
    if (l >= 0) {
      parity += 'L';
      left.push(l);
    } else if (g >= 0) {
      parity += 'G';
      left.push(g);
    } else return null;
  }

  const first = PARITY.indexOf(parity);
  if (first < 0) return null;

  const right: number[] = [];
  for (let i = 0; i < 6; i += 1) {
    const chunk = modules.slice(50 + i * 7, 57 + i * 7);
    const r = R.indexOf(chunk);
    if (r < 0) return null;
    right.push(r);
  }

  return `${first}${left.join('')}${right.join('')}`;
}

describe('encodeEan13', () => {
  it('round-trips every published code through an independent decoder', () => {
    for (const code of PUBLISHED_VALID) {
      const modules = encodeEan13(code);
      expect(modules).not.toBeNull();
      expect(decodeEan13(modules!)).toBe(code);
    }
  });

  it('round-trips a generated in-store code — the ones a shop will actually print', () => {
    for (let i = 1; i <= 50; i += 1) {
      const code = composeInStoreEan13('2001', i)!;
      expect(decodeEan13(encodeEan13(code)!)).toBe(code);
    }
  });

  it('carries the first digit in the LEFT PARITY, not in a bar', () => {
    // The whole reason a naive 12-digit reading produces an unscannable symbol.
    // Two codes differing only in their first digit must differ in parity while
    // the right half is byte-identical.
    const a = withEan13CheckDigit('100000000000');
    const b = withEan13CheckDigit('900000000000');
    const ma = encodeEan13(a)!;
    const mb = encodeEan13(b)!;
    // Digits 8-12 are '0' in both; the 13th is the check digit, which differs
    // because the payload does, so it is excluded from the comparison.
    expect(ma.slice(50, 85)).toBe(mb.slice(50, 85)); // right half identical
    expect(ma.slice(3, 45)).not.toBe(mb.slice(3, 45)); // left half differs
  });

  it('is exactly 95 modules with the three guards in place', () => {
    const modules = encodeEan13(PUBLISHED_VALID[0])!;
    expect(modules).toHaveLength(95);
    expect(modules.slice(0, 3)).toBe('101');
    expect(modules.slice(45, 50)).toBe('01010');
    expect(modules.slice(92)).toBe('101');
  });

  it('REFUSES the pilot barcodes — this is the 5.9 finding, at render time', () => {
    for (const code of PILOT_INVALID) {
      expect(encodeEan13(code)).toBeNull();
    }
    // The one that passes by coincidence draws perfectly well.
    expect(encodeEan13(PILOT_VALID[0])).not.toBeNull();
  });

  it('refuses anything that is not 13 digits', () => {
    for (const bad of ['', '123', 'ABCDEFGHIJKLM', '12345678901234']) {
      expect(encodeEan13(bad)).toBeNull();
    }
  });
});

describe('encodeCode128', () => {
  it('produces a symbol whose length matches the value it encodes', () => {
    // start (11) + n×11 + checksum (11) + stop (13)
    for (const value of ['A', 'SHIRT-0001-BLK-M', '1234567890']) {
      const modules = encodeCode128(value)!;
      expect(modules).toHaveLength(11 + value.length * 11 + 11 + 13);
    }
  });

  it('starts with the subset-B start pattern and ends with the stop pattern', () => {
    const modules = encodeCode128('A')!;
    expect(modules.startsWith('11010010000')).toBe(true); // 211214 → start B
    expect(modules.endsWith('1100011101011')).toBe(true); // 2331112 → stop
  });

  it('a one-character change changes the symbol — the checksum is live', () => {
    const a = encodeCode128('SHIRT-0001-BLK-M')!;
    const b = encodeCode128('SHIRT-0001-BLK-L')!;
    expect(a).not.toBe(b);
    expect(a).toHaveLength(b.length);
  });

  it('refuses what subset B cannot carry, rather than dropping it', () => {
    expect(encodeCode128('')).toBeNull();
    expect(encodeCode128('café')).toBeNull(); // é is outside 32-126
    expect(encodeCode128('tab\there')).toBeNull();
  });
});

describe('barcodeSvg', () => {
  it('draws bars for a valid code and nothing at all for an invalid one', () => {
    const good = barcodeSvg(PUBLISHED_VALID[0], 'EAN13', { widthMm: 30, heightMm: 10 })!;
    expect(good).toContain('<svg');
    expect(good.match(/<rect/g)!.length).toBeGreaterThan(20);

    // A placeholder or an empty box would put a label on a shelf that scans as
    // nothing, which is worse than no label.
    expect(barcodeSvg('2001000000015', 'EAN13', { widthMm: 30, heightMm: 10 })).toBeNull();
  });

  it('scales to the millimetres it is given', () => {
    const svg = barcodeSvg(PUBLISHED_VALID[0], 'EAN13', { widthMm: 34, heightMm: 9 })!;
    expect(svg).toContain('width="34mm"');
    expect(svg).toContain('height="9mm"');
    expect(svg).toContain('viewBox="0 0 34 9"');
  });
});

/**
 * Mutation proofs (D30 §5).
 */
describe('mutation proofs', () => {
  it('CAUGHT: a check digit computed with the weights the other way round', () => {
    const mutant = (payload: string): number => {
      let sum = 0;
      for (let i = 0; i < 12; i += 1) {
        sum += (payload.charCodeAt(i) - 48) * (i % 2 === 0 ? 3 : 1); // ← swapped
      }
      return (10 - (sum % 10)) % 10;
    };
    // MEASURED, not assumed: the swapped-weight mutant agrees with the correct
    // algorithm on TWO of the four published codes and disagrees on the other
    // two. A single-code assertion would therefore have had a coin-flip chance
    // of missing this entirely — which is the argument for the exact set below
    // rather than a spot check.
    const disagrees = PUBLISHED_VALID.filter(
      (code) => mutant(code.slice(0, 12)) !== ean13CheckDigit(code.slice(0, 12)),
    );
    expect(disagrees).toEqual(['4006381333931', '0075678164125']);

    // And the real validator refuses every code the mutant would have issued.
    for (const code of disagrees) {
      const issued = `${code.slice(0, 12)}${mutant(code.slice(0, 12))}`;
      expect(isValidEan13(issued)).toBe(false);
    }
  });

  it('CAUGHT: an encoder that uses L-codes for the whole left half', () => {
    const mutantLeftHalf = (code: string): string => {
      const digits = [...code].map((c) => c.charCodeAt(0) - 48);
      let out = '';
      for (let i = 0; i < 6; i += 1) out += L[digits[i + 1]!]!;
      return out;
    };
    // Only first-digit 0 uses LLLLLL, so any other first digit disagrees — and
    // a scanner reading LLLLLL would report the wrong product, not an error.
    const code = PUBLISHED_VALID[0]; // starts with 5
    expect(mutantLeftHalf(code)).not.toBe(encodeEan13(code)!.slice(3, 45));
    expect(decodeEan13(`101${mutantLeftHalf(code)}01010${encodeEan13(code)!.slice(50)}`)).not.toBe(
      code,
    );
  });

  it('CAUGHT: an allocator that truncates instead of refusing at end of range', () => {
    const mutant = (prefix: string, sequence: number): string => {
      const width = 12 - prefix.length;
      const body = String(sequence).slice(-width).padStart(width, '0');
      return withEan13CheckDigit(`${prefix}${body}`);
    };
    // 1,000,000 wraps to 000000 and REISSUES the very first code.
    expect(mutant('200100', 1000000)).toBe(mutant('200100', 0));
    expect(composeInStoreEan13('200100', 1000000)).toBeNull();
  });
});
