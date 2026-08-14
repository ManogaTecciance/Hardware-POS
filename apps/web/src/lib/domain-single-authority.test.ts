/**
 * D56 — business-type comparisons have ONE home: the domain registry.
 *
 * The bug class this guards: seven inline copies of
 * `businessType === 'RESTAURANT' || 'CAFE' || 'BAKERY'` each independently
 * omitted HOTEL, so a hotel workspace got the restaurant sidebar with the
 * retail POS and the retail product wizard behind it. The fix routed every
 * such decision through `domainFor(...)` capabilities; this spec is what stops
 * predicate number eight.
 *
 * Mutation-proven: reintroducing `businessType === 'RESTAURANT'` in the POS
 * page fails "the exact set of matching files is empty" naming the file.
 *
 * Per D30: the negative ("no file compares businessType to a literal") is
 * paired with positives — the analyser demonstrably matches the forbidden
 * pattern, and the two legitimate `businessType === null` unresolved-checks
 * still exist, so an analyser that matched nothing would fail loudly.
 */
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { collectFiles, stripComments } from '@/testkit/source-analysis';

const SRC = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');

/** A comparison of `businessType` against a string literal — the forbidden shape. */
const FORBIDDEN = /businessType\s*[!=]==\s*['"]/;

describe('no web source compares businessType to a literal', () => {
  it('the exact set of matching files is empty', () => {
    const offenders = collectFiles(SRC, {
      accept: (name) => /\.tsx?$/.test(name) && !/\.(test|spec|render\.test)\./.test(name),
      predicate: (content) => FORBIDDEN.test(stripComments(content)),
    });
    expect(offenders).toEqual([]);
  });

  it('the analyser can actually match the forbidden shape', () => {
    // POSITIVE CONTROL (D30 rule 5): each historical variant of the predicate
    // is recognised, so the empty set above is detection working, not a
    // pattern that matches nothing.
    expect(FORBIDDEN.test(`profile?.businessType === 'RESTAURANT'`)).toBe(true);
    expect(FORBIDDEN.test(`businessType !== "HOTEL"`)).toBe(true);
    expect(FORBIDDEN.test(`x.businessType==='CAFE'`)).toBe(true);
    // …and the legitimate unresolved-check is NOT forbidden.
    expect(FORBIDDEN.test(`input.businessType === null`)).toBe(false);
  });

  it('the unresolved-check still exists where it should', () => {
    // Anchors the "legitimate use survives" claim to the real files, so the
    // rule cannot silently become "nothing may mention businessType at all".
    const nullChecks = collectFiles(SRC, {
      accept: (name) => /\.tsx?$/.test(name) && !/\.(test|spec)\./.test(name),
      predicate: (content) => /businessType\s*===\s*null/.test(content),
    });
    expect(nullChecks).toEqual(['lib/nav.ts', 'lib/products/product-presentation.ts']);
  });
});

describe('the food-service literals live in exactly one file', () => {
  it('CAFE / BAKERY / HOTEL appear only in the nav registry cache', () => {
    /*
     * nav.ts enumerates the total registry (a Record must name its keys);
     * everything else reads capabilities. A second file naming these values
     * is a new by-business-type map growing outside the registry.
     */
    const offenders = collectFiles(SRC, {
      accept: (name) => /\.tsx?$/.test(name) && !/\.(test|spec|render\.test)\./.test(name),
      predicate: (content) => /'(CAFE|BAKERY|HOTEL)'/.test(stripComments(content)),
    });
    expect(offenders).toEqual(['lib/nav.ts']);
  });
});
