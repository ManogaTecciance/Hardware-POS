/**
 * @vitest-environment jsdom
 *
 * A real DOM, deliberately. `readBillGeometry` is the seam between the
 * template and the printer, and testing it against a hand-rolled fake would
 * assert the fake's `querySelector` rather than a browser's.
 */
/**
 * D99 — the roll geometry resolver.
 *
 * ## Why the fixtures share no digits with the defaults
 *
 * Every function here has a plausible broken implementation that ignores its
 * input and returns the defaults, and that implementation passes any test
 * written only against the default profile. So the non-default fixture is
 * 58/2/4 — no digit in common with 78/3/5 — and `pageWidthPx` 219 against the
 * default's 295. A read that silently fell back could not produce those.
 */
import { describe, expect, it } from 'vitest';

import { DEFAULT_DOCUMENT_PROFILE } from './document-template-service';
import {
  billBodyGeometryCss,
  billGeometryMetaTags,
  BILL_GEOMETRY_LIMITS,
  CUTTER_MARGIN_MM,
  DEFAULT_BILL_GEOMETRY,
  mmToPx,
  pageHeightMm,
  pxToMm,
  readBillGeometry,
  resolveBillGeometry,
} from './thermal-bill-geometry';

/** A real DOM, so `readBillGeometry` is exercised against a real querySelector. */
function docOf(head: string): Document {
  return new DOMParser().parseFromString(`<!doctype html><html><head>${head}</head><body></body></html>`, 'text/html');
}

describe('resolveBillGeometry', () => {
  it('answers the shipped printer’s numbers for a default profile', () => {
    /*
     * Whole-object, not field-by-field: a field added to `BillGeometry` and
     * left unpopulated would slip past a set of `toContain`-style checks, and
     * the consumers of this object treat every field as load-bearing.
     */
    expect(resolveBillGeometry(DEFAULT_DOCUMENT_PROFILE)).toEqual({
      pageWidthMm: 78,
      leftInsetMm: 3,
      rightInsetMm: 5,
      contentWidthMm: 70,
      pageWidthPx: 295,
      fitToContent: true,
    });
  });

  it('falls back to the same answer when there is no profile at all', () => {
    // The print frame's provisional layout depends on this: a document with no
    // geometry must lay out exactly as it did before D99.
    expect(resolveBillGeometry(null)).toEqual(resolveBillGeometry(DEFAULT_DOCUMENT_PROFILE));
    expect(resolveBillGeometry(undefined).pageWidthPx).toBe(295);
  });

  it('honours a workspace that measured its own roll', () => {
    const g = resolveBillGeometry({
      billPaperWidthMm: 58,
      billLeftInsetMm: 2,
      billRightInsetMm: 4,
      billFitToContent: false,
    });
    expect(g).toEqual({
      pageWidthMm: 58,
      leftInsetMm: 2,
      rightInsetMm: 4,
      contentWidthMm: 52,
      pageWidthPx: 219,
      fitToContent: false,
    });
    // …and nothing of the default survived, which is what proves it was read.
    expect(g.pageWidthPx).not.toBe(295);
  });

  it('derives the column and the pixel width rather than reading them', () => {
    // A profile cannot state these, so a stored blob carrying them must not be
    // able to make the CSS and the layout disagree.
    const g = resolveBillGeometry({
      billPaperWidthMm: 80,
      billLeftInsetMm: 4,
      billRightInsetMm: 6,
      contentWidthMm: 999,
      pageWidthPx: 999,
    } as never);
    expect(g.contentWidthMm).toBe(70);
    expect(g.pageWidthPx).toBe(mmToPx(80));
  });

  describe('a settings blob can hold anything an older client wrote', () => {
    /*
     * Out of range falls back to the DEFAULT, never to the nearest bound: 500
     * is not a request for 120, it is a corrupt setting, and printing 120mm of
     * bill would hide it. Each row also asserts the post-condition that keeps
     * a bill printable at all.
     */
    const bad = [
      ['not a number', { billPaperWidthMm: '78' }],
      ['NaN', { billPaperWidthMm: Number.NaN }],
      ['Infinity', { billPaperWidthMm: Number.POSITIVE_INFINITY }],
      ['null', { billPaperWidthMm: null }],
      ['zero', { billPaperWidthMm: 0 }],
      ['negative', { billPaperWidthMm: -78 }],
      ['far too wide', { billPaperWidthMm: 500 }],
      ['just under the floor', { billPaperWidthMm: 39 }],
      ['a negative inset', { billLeftInsetMm: -3 }],
      ['an inset past the bound', { billRightInsetMm: 21 }],
    ] as const;

    for (const [name, over] of bad) {
      it(`falls back on ${name}, and still leaves a column to print in`, () => {
        const g = resolveBillGeometry(over as never);
        expect(g.contentWidthMm).toBeGreaterThan(0);
        expect(g.pageWidthMm).toBeGreaterThanOrEqual(40);
        // The field that was NOT corrupted is untouched — a blanket reset to
        // defaults would pass every assertion above and lose a good setting.
        if (!('billLeftInsetMm' in (over as object))) expect(g.leftInsetMm).toBe(3);
      });
    }

    it('accepts each bound, so the fallback is not swallowing valid settings', () => {
      // The positive half: without this, a resolver that rejected EVERYTHING
      // would pass the whole table above.
      expect(resolveBillGeometry({ billPaperWidthMm: 40 }).pageWidthMm).toBe(40);
      expect(resolveBillGeometry({ billPaperWidthMm: 120 }).pageWidthMm).toBe(120);
      expect(resolveBillGeometry({ billLeftInsetMm: 0 }).leftInsetMm).toBe(0);
      expect(resolveBillGeometry({ billRightInsetMm: 20 }).rightInsetMm).toBe(20);
    });

    it('reverts both insets when together they swallow the column', () => {
      // 20 and 20 are each inside the individual bound and leave 18mm of a
      // 58mm roll — a vertical column of single letters.
      const g = resolveBillGeometry({
        billPaperWidthMm: 58,
        billLeftInsetMm: 20,
        billRightInsetMm: 20,
      });
      expect(g.leftInsetMm).toBe(3);
      expect(g.rightInsetMm).toBe(5);
      expect(g.contentWidthMm).toBe(50);
    });

    it('keeps a printable column on the narrowest page the bounds allow', () => {
      /*
       * The bounds carry the guarantee that reverting the INSETS is always
       * enough, so the resolver needs no second fallback for the page. Asserted
       * as arithmetic on the limits rather than on one example, because the
       * thing that could break it is somebody changing a bound — which no
       * fixture would notice.
       */
      const { pageWidthMm, minContentMm } = BILL_GEOMETRY_LIMITS;
      const defaultInsets = DEFAULT_BILL_GEOMETRY.leftInsetMm + DEFAULT_BILL_GEOMETRY.rightInsetMm;
      expect(pageWidthMm.min - defaultInsets).toBeGreaterThanOrEqual(minContentMm);

      const g = resolveBillGeometry({
        billPaperWidthMm: pageWidthMm.min,
        billLeftInsetMm: 19,
        billRightInsetMm: 19,
      });
      expect(g.contentWidthMm).toBeGreaterThanOrEqual(minContentMm);
      // The operator's page survives — only the impossible insets were undone.
      expect(g.pageWidthMm).toBe(pageWidthMm.min);
    });
  });
});

describe('mm and px', () => {
  it('converts at 96dpi', () => {
    expect(mmToPx(78)).toBe(295);
    expect(mmToPx(58)).toBe(219);
    expect(pxToMm(96)).toBeCloseTo(25.4, 6);
  });
});

describe('pageHeightMm — D102, a page is never wider than it is tall', () => {
  const g = resolveBillGeometry(DEFAULT_DOCUMENT_PROFILE);

  it('takes the height from the content whenever the content is tall enough', () => {
    // 267mm is the value every existing @page spec pins from a 1000px fixture.
    // Asserting it here is what proves the floor does not disturb the normal
    // path — the path that has been printing correctly all along.
    expect(pageHeightMm(g, 1000)).toBe(267);
    expect(pageHeightMm(g, 520)).toBe(140);
    expect(pageHeightMm(g, 300)).toBe(82);
  });

  it('floors a short bill above the paper width, instead of turning it sideways', () => {
    /*
     * The reported bug, with the numbers MEASURED in Chromium at a 295px
     * layout width rather than estimated: with the logo and every header field
     * cleared, a one-item bill renders 213px (56.4mm) and used to declare a
     * 78mm x 59mm page. That is a landscape page box, and the till printed it
     * rotated 90° on the roll.
     */
    expect(pageHeightMm(g, 213)).toBe(80);
    /*
     * The calibration strip measures 275px (72.8mm) and declared 78mm x 75mm —
     * which is exactly what the live run on 2026-09-01 was observed injecting.
     * The instrument built for D99 was carrying this defect itself.
     */
    expect(pageHeightMm(g, 275)).toBe(80);
    /*
     * The boundary, walked one step at a time. The crossover sits at exactly
     * `mmToPx(pageWidthMm)` — 295px — which is the rule restated: the floor
     * stops applying at the moment the content becomes as tall as the paper is
     * wide. Below that the floor answers; at and above it the content does.
     */
    expect(mmToPx(g.pageWidthMm)).toBe(295);
    expect(pageHeightMm(g, 287)).toBe(80); // content would ask 78mm — a square page
    expect(pageHeightMm(g, 294)).toBe(80); // content would ask 80mm — a tie
    expect(pageHeightMm(g, 295)).toBe(81); // content wins from here on
    expect(pageHeightMm(g, 310)).toBe(85);
  });

  it('never returns a height that is not strictly greater than the width', () => {
    /*
     * The rule itself, as a property rather than a handful of samples. A page
     * box carries its orientation in its two lengths, so this single inequality
     * is the whole of what keeps the bill upright — and a square page is the
     * ambiguous case, which is why it is `>` and not `>=`.
     */
    for (let px = 1; px <= 2000; px += 7) {
      expect(pageHeightMm(g, px)).toBeGreaterThan(g.pageWidthMm);
    }
    // Zero and negative reach this function only if a caller drops its guard;
    // it must still answer with a printable page rather than 2mm.
    expect(pageHeightMm(g, 0)).toBeGreaterThan(g.pageWidthMm);
    expect(pageHeightMm(g, -500)).toBeGreaterThan(g.pageWidthMm);
  });

  it('takes the floor from the workspace’s roll, not from a default 78', () => {
    const narrow = resolveBillGeometry({
      billPaperWidthMm: 58,
      billLeftInsetMm: 2,
      billRightInsetMm: 4,
    });
    expect(pageHeightMm(narrow, 180)).toBe(60);
    // The anti-hard-code half: 80 is the 78mm roll's floor and must not appear.
    expect(pageHeightMm(narrow, 180)).not.toBe(80);
    expect(pageHeightMm(narrow, 180)).toBeGreaterThan(narrow.pageWidthMm);
    // …and a wide roll floors higher still, so the floor really does track it.
    expect(pageHeightMm(resolveBillGeometry({ billPaperWidthMm: 110 }), 180)).toBe(112);
  });

  it('MUTATION PROOF — the fixtures above really are in the landscape regime', () => {
    /*
     * `pageHeightMm(g, 180) === 80` says nothing on its own: a function that
     * ignored the floor entirely would be caught only if 180px would otherwise
     * have produced something SMALLER than the page width. That is the claim,
     * written out — this is the exact arithmetic the code used before D102.
     */
    const beforeD102 = (px: number) => Math.ceil(pxToMm(px)) + CUTTER_MARGIN_MM;
    expect(beforeD102(213)).toBe(59);
    expect(beforeD102(275)).toBe(75);
    expect(beforeD102(213)).toBeLessThan(g.pageWidthMm);
    expect(beforeD102(275)).toBeLessThan(g.pageWidthMm);
    // …and the companion: the tall fixture is NOT in the regime, so the
    // "takes the height from the content" test above is not floored either.
    expect(beforeD102(1000)).toBe(267);
    expect(beforeD102(1000)).toBeGreaterThan(g.pageWidthMm);
  });
});

describe('billBodyGeometryCss', () => {
  it('emits the page cap, zero margin and both insets, in millimetres', () => {
    const css = billBodyGeometryCss(resolveBillGeometry(DEFAULT_DOCUMENT_PROFILE));
    expect(css).toBe('width:100%;max-width:78mm;margin:0;padding:0 5mm 0 3mm');
  });

  it('caps at exactly the page width and never centres', () => {
    /*
     * The cap is only safe at the page width. Narrower than the page plus
     * centring IS the band of white down both margins that D79 rejected, and
     * both halves of that shape are asserted against here.
     */
    const g = resolveBillGeometry({ billPaperWidthMm: 58, billLeftInsetMm: 2, billRightInsetMm: 4 });
    const css = billBodyGeometryCss(g);
    expect(css).toContain(`max-width:${g.pageWidthMm}mm`);
    expect(css).not.toMatch(/margin:\s*0\s+auto/);
    expect(css).not.toContain('78mm');
  });
});

describe('the geometry travels in the document', () => {
  it('round-trips through the meta tags', () => {
    for (const profile of [
      DEFAULT_DOCUMENT_PROFILE,
      { billPaperWidthMm: 58, billLeftInsetMm: 2, billRightInsetMm: 4, billFitToContent: false },
      // Non-integer millimetres: a driver stock is 78.7mm, and an operator who
      // types that must not have it silently rounded to a different page.
      { billPaperWidthMm: 78.5, billLeftInsetMm: 2.5, billRightInsetMm: 4.5 },
    ]) {
      const g = resolveBillGeometry(profile as never);
      expect(readBillGeometry(docOf(billGeometryMetaTags(g)))).toEqual(g);
    }
  });

  it('returns null for every document that carries no geometry', () => {
    /*
     * Null is what keeps the retail receipt, the quotation and the return on
     * the behaviour they have always had (D16). Each shape below has actually
     * reached `printReceipt` or is one rename away from doing so.
     */
    expect(readBillGeometry(docOf(''))).toBeNull(); // a server-rendered receipt
    expect(readBillGeometry(docOf('<meta name="hpos:page-width-mm" content="wide">'))).toBeNull();
    expect(readBillGeometry(docOf('<meta name="page-width-mm" content="78">'))).toBeNull(); // renamed
    expect(readBillGeometry(docOf('<meta name="hpos:page-width-mm" content="78">'))).toBeNull(); // partial
    expect(readBillGeometry(docOf('<meta name="hpos:page-width-mm" content="0">'))).toBeNull();
    expect(readBillGeometry(null)).toBeNull();
    // The hand-rolled fake document in `receipt-print.iframe.test.ts`.
    expect(readBillGeometry({} as never)).toBeNull();
  });

  it('reads the document rather than answering from the defaults', () => {
    /*
     * MUTATION PROOF for the null-returning tests above.
     *
     * A `readBillGeometry` that ignored the document and returned
     * `resolveBillGeometry(null)` would satisfy every round-trip assertion
     * that used only the default profile. This is the case that kills it: the
     * numbers are the 58/2/4 fixture, and the assertion is that NONE of the
     * defaults came back.
     */
    const g = readBillGeometry(
      docOf(
        billGeometryMetaTags(
          resolveBillGeometry({ billPaperWidthMm: 58, billLeftInsetMm: 2, billRightInsetMm: 4 }),
        ),
      ),
    );
    expect(g?.pageWidthMm).toBe(58);
    expect(g?.pageWidthPx).toBe(219);
    expect(g?.pageWidthMm).not.toBe(DEFAULT_BILL_GEOMETRY.pageWidthMm);
    expect(g?.pageWidthPx).not.toBe(295);
  });

  it('honours a fit flag that was switched off', () => {
    // Both directions: a reader that always returned true passes the positive.
    const off = resolveBillGeometry({ billFitToContent: false });
    expect(readBillGeometry(docOf(billGeometryMetaTags(off)))?.fitToContent).toBe(false);
    const on = resolveBillGeometry({ billFitToContent: true });
    expect(readBillGeometry(docOf(billGeometryMetaTags(on)))?.fitToContent).toBe(true);
  });
});
