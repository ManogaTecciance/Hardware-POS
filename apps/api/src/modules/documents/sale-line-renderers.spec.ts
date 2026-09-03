import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  saleLineLabel,
  saleLinePromotionNote,
  splitLineDiscounts,
  taxBreakdownForDocument,
  taxRateLabel,
} from '@hardware-pos/shared';

import { referencesIdentifier, stripComments } from '../providers/testkit/source-analysis';

/**
 * D99 (2.12) — every renderer of a sold line names the variant.
 *
 * ## Why this test exists
 *
 * 1c.7 put the size on the receipt and believed the job done. It was not: a sale
 * line is rendered in FOUR places, and only two were found. The same sale then
 * printed with `M / Navy` from the server's A4 endpoint and as a bare
 * `Cotton T-Shirt` from the web app's own A4 — discovered by a person looking at
 * a customer-facing invoice, which is the expensive way to find it.
 *
 * The root defect was never the missing line. It was four copies of one rule.
 * `saleLineLabel` in `@hardware-pos/shared` is now the single authority, and
 * this spec is what stops a fifth renderer being added blind: it enumerates the
 * files that render a sold line and fails if one does not call the shared
 * formatter.
 *
 * ## Why source inspection, and how it is kept honest (D30)
 *
 * Two of the four renderers are React components in `apps/web`; this suite
 * cannot import them. So the check is textual — which is exactly the kind of
 * test D30 warns can pass while asserting nothing. Three guards:
 *
 *   1. every listed file must EXIST and be non-empty (a renamed file fails
 *      loudly rather than silently inspecting nothing);
 *   2. the positive assertion is paired with a negative — the raw field access
 *      the bug looked like must be absent;
 *   3. the formatter's own behaviour is asserted against the real function, not
 *      re-expressed here.
 */

const REPO = resolve(__dirname, '../../../../..');

/**
 * Every file that renders a sold line onto a document a customer or clerk
 * reads. Adding a renderer means adding it here.
 */
const SALE_LINE_RENDERERS: readonly { file: string; what: string }[] = [
  {
    file: 'apps/api/src/modules/documents/documents.service.ts',
    what: "the server's A4 invoice, and the credit note for a return",
  },
  {
    file: 'apps/api/src/modules/receipts/receipts.service.ts',
    what: "the server's 80mm thermal receipt",
  },
  {
    file: 'apps/web/src/components/documents/sale-a4-document.tsx',
    what: 'the A4 the web app renders itself',
  },
  {
    file: 'apps/web/src/lib/receipt-print.ts',
    what: 'the client fallback when the server render fails',
  },
];

function sourceOf(relative: string): string {
  const text = readFileSync(resolve(REPO, relative), 'utf8');
  // An empty or moved file would let every assertion below pass vacuously.
  expect(text.length).toBeGreaterThan(200);
  return text;
}

/**
 * The body of one named method, so a negative assertion can name a builder
 * rather than a whole file. `documents.service` holds the sale, return AND
 * quotation builders, and only the first two have a variant to print.
 */
function body(source: string, methodName: string): string {
  const start = source.indexOf(`${methodName}(`);
  // A renamed method would otherwise slice nothing and pass every assertion.
  expect(start).toBeGreaterThan(-1);
  const rest = source.slice(start);
  const end = rest.indexOf('\n  }');
  expect(end).toBeGreaterThan(-1);
  return stripComments(rest.slice(0, end));
}

describe('every sale-line renderer uses the shared formatter', () => {
  it.each(SALE_LINE_RENDERERS)('$file — $what', ({ file }) => {
    const source = stripComments(sourceOf(file));

    expect(referencesIdentifier(source, 'saleLineLabel')).toBe(true);
  });

  it.each(SALE_LINE_RENDERERS)('$file also uses the shared tax breakdown (3.12)', ({ file }) => {
    // Same enumeration, second shared rule. `SaleItem.taxAmount` is always 0, so
    // a breakdown cannot be summed from lines — it ALLOCATES the recorded total,
    // and two ways to divide one total is two chances to disagree.
    //
    // `receipts.service` computes the rows and its TEMPLATE prints them, so
    // either identifier counts for that file.
    const source = stripComments(sourceOf(file));

    expect(
      referencesIdentifier(source, 'taxBreakdownForDocument') ||
        referencesIdentifier(source, 'taxRateLabel'),
    ).toBe(true);
  });

  it.each(SALE_LINE_RENDERERS)('$file also names the promotion (D102, 4.6)', ({ file }) => {
    /*
     * Same enumeration, third shared rule. A promoted line prints at 0.00, and a
     * zero with no reason beside it reads as a pricing error rather than a gift.
     *
     * `receipts.service` builds the note and its TEMPLATE prints it, so either
     * identifier counts for that file — the same allowance the tax breakdown
     * above makes, and for the same split.
     */
    const source = stripComments(sourceOf(file));

    expect(
      referencesIdentifier(source, 'saleLinePromotionNote') ||
        referencesIdentifier(source, 'promotionNote'),
    ).toBe(true);
  });

  it.each(SALE_LINE_RENDERERS)('$file splits the discount rows the same way', ({ file }) => {
    /*
     * 4.4 folded promotions into `totalDiscount` because the maths requires it,
     * which left every bill printing "Product discount" for a buy-two-get-one.
     * `splitLineDiscounts` is the one authority for the division; four
     * subtractions would be four chances to disagree.
     */
    const source = stripComments(sourceOf(file));

    expect(
      referencesIdentifier(source, 'splitLineDiscounts') ||
        referencesIdentifier(source, 'promotionDiscount'),
    ).toBe(true);
  });

  it('the shared formatter names the offer, and says nothing when there is none', () => {
    expect(saleLinePromotionNote('Buy 2 shirts, tie free')).toBe(
      'Promotion: Buy 2 shirts, tie free',
    );
    // NEGATIVE: null rather than an empty string, so a renderer's `?` is enough.
    expect(saleLinePromotionNote(null)).toBeNull();
    expect(saleLinePromotionNote('   ')).toBeNull();
  });

  it('the shared split reduces to today for a sale with no promotions', () => {
    // The zero-change guarantee, held in one place rather than four.
    expect(splitLineDiscounts([{ promotionDiscountAmount: 0 }], 120)).toEqual({
      manual: 120,
      promotional: 0,
    });
    // …and divides when there is something to divide.
    expect(
      splitLineDiscounts([{ promotionDiscountAmount: 500 }, { promotionDiscountAmount: 0 }], 700),
    ).toEqual({ manual: 200, promotional: 500 });
    // NEGATIVE: rounding cannot produce a negative manual row.
    expect(splitLineDiscounts([{ promotionDiscountAmount: 500 }], 499.99).manual).toBe(0);
  });

  it('names all four renderers — a fifth added blind is the failure mode', () => {
    // An exact set rather than a count (D30). If a renderer is added and listed,
    // this fails and someone has to think; if added and NOT listed, the reviewer
    // sees an untested file. Neither is silent.
    expect(SALE_LINE_RENDERERS.map((r) => r.file)).toEqual([
      'apps/api/src/modules/documents/documents.service.ts',
      'apps/api/src/modules/receipts/receipts.service.ts',
      'apps/web/src/components/documents/sale-a4-document.tsx',
      'apps/web/src/lib/receipt-print.ts',
    ]);
  });

  it('no SALE renderer prints a bare product name beside the quantity', () => {
    // The NEGATIVE half. The bug looked exactly like `name: it.productName` and
    // `<td>{it.productName}</td>` — the field reaching the document without
    // passing through the formatter.
    //
    // Scoped to the sale/return builders rather than whole files: the first
    // draft of this assertion was file-wide and flagged
    // `buildQuotationDocument`, which is CORRECT to print a bare name.
    // `QuotationItem` has no `productVariantId` column at all, so a quotation
    // cannot name a size — a real gap for a clothing shop, but a schema question
    // and not this bug.
    const saleBuilders = [
      body(sourceOf(SALE_LINE_RENDERERS[0]!.file), 'buildSaleDocument'),
      body(sourceOf(SALE_LINE_RENDERERS[0]!.file), 'buildReturnDocument'),
      ...SALE_LINE_RENDERERS.slice(1).map((r) => stripComments(sourceOf(r.file))),
    ];

    for (const source of saleBuilders) {
      expect(source).not.toContain('name: it.productName,');
      expect(source).not.toContain('name: it.productNameSnapshot,');
      expect(source).not.toContain('{it.productName}<');
    }
  });

  it('the quotation builder is deliberately excluded, and would fail if included', () => {
    // Proves the exclusion above is a decision rather than a hole: the quotation
    // builder really does print a bare name, and really does lack a variant to
    // print. If quotations ever gain `productVariantId`, this test fails and
    // whoever adds the column is told to add the renderer to the list.
    const quotation = body(sourceOf(SALE_LINE_RENDERERS[0]!.file), 'buildQuotationDocument');

    expect(quotation).toContain('name: it.productName,');
    expect(quotation).not.toContain('saleLineLabel');
  });
});

describe('the formatter itself', () => {
  it('renders the PO format: Cotton T-Shirt (M — Navy)', () => {
    expect(saleLineLabel('Cotton T-Shirt', 'M / Navy')).toBe('Cotton T-Shirt (M — Navy)');
  });

  it('converts every stored separator, not just the first', () => {
    // A three-axis variant would otherwise print "M — Navy / Cotton".
    expect(saleLineLabel('Shirt', 'M / Navy / Cotton')).toBe('Shirt (M — Navy — Cotton)');
  });

  it('leaves a single-axis variant alone but still wraps it', () => {
    expect(saleLineLabel('Denim Jeans', '32')).toBe('Denim Jeans (32)');
  });

  it('returns the bare name when nothing was varied', () => {
    // Loose goods, a service, a single-SKU product, and every sale in history.
    expect(saleLineLabel('Basmati Rice 1kg', null)).toBe('Basmati Rice 1kg');
    expect(saleLineLabel('Basmati Rice 1kg', undefined)).toBe('Basmati Rice 1kg');
  });

  it('treats a blank snapshot as absent rather than printing empty brackets', () => {
    // "Cotton T-Shirt ()" on a customer's receipt reads as a bug.
    expect(saleLineLabel('Cotton T-Shirt', '   ')).toBe('Cotton T-Shirt');
    expect(saleLineLabel('Cotton T-Shirt', '')).toBe('Cotton T-Shirt');
  });

  it('does not mutate the stored snapshot form', () => {
    // D44 freezes `variantNameSnapshot` at sale time. The slash form stays in
    // the database and in the till's picker; only the document reads differently.
    const stored = 'M / Navy';
    saleLineLabel('Cotton T-Shirt', stored);

    expect(stored).toBe('M / Navy');
  });
});

/**
 * D101 (3.12) — a single-rate document renders exactly what it rendered before.
 *
 * The zero-change guarantee for hardware and restaurant, asserted on the shared
 * allocation itself rather than on four renderers: every one of them takes the
 * "no rows" path for the same reason, so proving the allocation returns nothing
 * proves all four are byte-identical.
 */
describe('the breakdown is silent unless it adds information', () => {
  const line = (taxable: number, rate: number | null) => ({ taxable, taxRatePercent: rate });

  it('returns NOTHING when every line shares one rate', () => {
    // Every tenant today. A row repeating the single total already printed adds
    // a line and no information.
    expect(taxBreakdownForDocument([line(1000, 18), line(500, 18)], 270)).toEqual([]);
  });

  it('returns nothing when a document carries no lines at all', () => {
    /*
     * Kept as its own case because the function must handle it, but NOT as the
     * restaurant case any more — see below. Under D51 `closeSession` wrote
     * totals only and this WAS the restaurant shape; D58 changed that, and the
     * old justification here outlived the fact it described (found in 3.16).
     */
    expect(taxBreakdownForDocument([], 360)).toEqual([]);
  });

  it('returns nothing for a RESTAURANT sale — lines PRESENT, every rate null', () => {
    /*
     * The shape a restaurant bill actually has since D58: `table-sessions` and
     * `takeaway` settle by projecting order items into SaleItem rows, so the
     * sale DOES carry lines. `ProjectedSaleItem` has no `taxRatePercent` field,
     * so every one of those rows is written NULL — on a bill settled today, not
     * only on history.
     *
     * That, and not the absence of lines, is why a restaurant bill prints no
     * breakdown. Deliberately the same assertion shape as the pre-3.8 case
     * below and deliberately NOT merged with it: one code path, two unrelated
     * real-world causes, and collapsing them is how the stale justification
     * above survived as long as it did.
     */
    expect(taxBreakdownForDocument([line(1200, null), line(800, null)], 360)).toEqual([]);
  });

  it('returns nothing for a sale predating 3.8', () => {
    // One missing rate makes the whole weight unusable, which is correct: those
    // documents print what they always printed.
    expect(taxBreakdownForDocument([line(1000, null), line(500, null)], 270)).toEqual([]);
    // Even a partially-snapshotted sale, which 3.9 makes impossible but a
    // hand-edited row could produce.
    expect(taxBreakdownForDocument([line(1000, 18), line(500, null)], 270)).toEqual([]);
  });

  it('returns nothing when a single rate is zero', () => {
    // A tenant configured at 0%: one rate, nothing to break down.
    expect(taxBreakdownForDocument([line(1000, 0), line(500, 0)], 0)).toEqual([]);
  });
});

describe('the breakdown when rates differ', () => {
  const line = (taxable: number, rate: number | null) => ({ taxable, taxRatePercent: rate });

  it('splits by rate and sums EXACTLY to the recorded total', () => {
    const rows = taxBreakdownForDocument([line(1000, 18), line(250.5, 0)], 180);

    expect(rows).toEqual([
      { ratePercent: 18, taxable: 1000, taxAmount: 180 },
      { ratePercent: 0, taxable: 250.5, taxAmount: 0 },
    ]);
    expect(rows.reduce((a, r) => a + r.taxAmount, 0)).toBe(180);
  });

  it('SHOWS the zero-rated row rather than hiding it', () => {
    // Proving an item was zero-rated is often a legal requirement, and it is the
    // line a shopper looks for when a price seems wrong (PO, 2026-09-02).
    const rows = taxBreakdownForDocument([line(1000, 18), line(250.5, 0)], 180);

    expect(rows.map((r) => r.ratePercent)).toContain(0);
  });

  it('orders highest rate first, deterministically', () => {
    const rows = taxBreakdownForDocument([line(100, 0), line(100, 18), line(100, 8)], 26);

    expect(rows.map((r) => r.ratePercent)).toEqual([18, 8, 0]);
  });

  it('absorbs rounding drift so the rows equal the printed total', () => {
    // Each row rounds independently, so the sum can miss by a cent. Absorbing is
    // legitimate here and was NOT for returns: a document shows the whole
    // partition at once, so there is always a row to carry the remainder. A
    // refund sees one line at a time and may be split across weeks.
    for (const tax of [100.01, 33.33, 0.01, 999.99]) {
      const rows = taxBreakdownForDocument([line(333.33, 15), line(333.33, 7.5), line(1, 0)], tax);
      const summed = Math.round(rows.reduce((a, r) => a + r.taxAmount, 0) * 100) / 100;

      expect(summed).toBe(tax);
    }
  });

  it('never divides by zero when every rate is zero but tax was recorded', () => {
    // Unreachable via 3.10, which charges nothing when all lines are exempt —
    // but a guard that only holds while another module behaves is not a guard.
    const rows = taxBreakdownForDocument([line(1000, 0), line(500, 0)], 50);

    expect(rows).toEqual([]);
  });

  it('labels a rate the way a customer reads it', () => {
    expect(taxRateLabel(18)).toBe('18%');
    expect(taxRateLabel(7.5)).toBe('7.5%');
    expect(taxRateLabel(0)).toBe('0%');
  });
});
