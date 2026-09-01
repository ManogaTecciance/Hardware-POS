import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { saleLineLabel } from '@hardware-pos/shared';

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
