/**
 * D72 — the printed restaurant bill.
 *
 * ## Why this is asserted on the emitted HTML
 *
 * The bill is the one customer-facing document the app produces, and every
 * failure mode here is silent: a missing logo, a fabricated tax line, a
 * "Balance due" on a bill the guest already settled, or a discount quietly
 * absorbed into the total all look fine in review and wrong on paper.
 *
 * Each conditional row is asserted in BOTH directions — absent when zero,
 * present when not — because a template that dropped the row unconditionally
 * satisfies a one-sided test just as well as a correct one.
 */
import { describe, expect, it, beforeEach } from 'vitest';

import { DEFAULT_DOCUMENT_PROFILE } from './document-template-service';
import { renderThermalBill, type ThermalBillInput } from './thermal-bill';

const profile = {
  ...DEFAULT_DOCUMENT_PROFILE,
  companyName: 'Praneetha',
  addressLine: 'No. 201, Muhandiram Road,\nKollupitiya, Colombo 03',
  phone: '0112 33 33 99 / 0112 33 33 88',
  logoUrl: 'data:image/png;base64,AAAA',
  footerText: 'Thank You! Come Again.',
};

const base: ThermalBillInput = {
  profile,
  currency: 'LKR',
  documentNumber: 'S-000057',
  placeLabel: 'M1/10',
  servedBy: 'cashier',
  issuedAt: new Date('2026-07-15T13:40:00'),
  lines: [
    { name: 'CHKN F/RCE/S', variantName: null, quantity: '1.000', lineTotal: '1000.00' },
    { name: 'BEEF F/RCE/S', variantName: null, quantity: '1.000', lineTotal: '1200.00' },
  ],
  subtotal: '2200.00',
  total: '2200.00',
  paid: '2200.00',
  balance: '0.00',
  payments: [{ method: 'CASH', amount: '2200.00' }],
};

let html = '';
const render = (over: Partial<ThermalBillInput> = {}) => {
  html = renderThermalBill({ ...base, ...over });
  return html;
};

beforeEach(() => {
  html = '';
});

describe('the header, as the reference bill lays it out', () => {
  it('centres the logo, then the address, then the contact numbers', () => {
    render();
    // The logo is an <img> from the document profile — settable in Settings,
    // which is the whole point of reading it from there.
    expect(html).toContain('src="data:image/png;base64,AAAA"');
    expect(html).toContain('Muhandiram Road');
    expect(html).toContain('0112 33 33 99 / 0112 33 33 88');

    // ORDER matters: logo → address → phone. Asserted by position, because
    // all three being present says nothing about the layout.
    const logoAt = html.indexOf('<img');
    const addressAt = html.indexOf('Muhandiram');
    const phoneAt = html.indexOf('0112 33');
    expect(logoAt).toBeGreaterThan(-1);
    expect(logoAt).toBeLessThan(addressAt);
    expect(addressAt).toBeLessThan(phoneAt);

    // And they are inside the centred block, not merely somewhere on paper.
    const centred = html.slice(html.indexOf('<div class="c">'), html.indexOf('</div>\n\n<div class="meta">'));
    expect(centred).toContain('<img');
    expect(centred).toContain('Muhandiram');
    expect(centred).toContain('0112 33');
  });

  it('prints the NAME instead of the logo when there is no logo', () => {
    render({ profile: { ...profile, logoUrl: null } });
    // NEGATIVE — no empty <img> box on the paper…
    expect(html).not.toContain('<img');
    // …POSITIVE — the name takes its place, so the header is never anonymous.
    expect(html).toContain('<h1>Praneetha</h1>');
    expect(html).toContain('Muhandiram');
  });

  it('does not print the name UNDER a logo that already carries it', () => {
    // The reference bill's mark is a wordmark; printing the company name
    // beneath it gives the guest the brand twice.
    render();
    expect(html).toContain('<img');
    expect(html).not.toContain('<h1>');
    // The name survives as the image's alt text, which is what a screen
    // reader and a failed image load both fall back to.
    expect(html).toContain('alt="Praneetha"');
  });

  it('carries served-by, the date, the bill number and the table', () => {
    render();
    expect(html).toContain('Served By: cashier');
    expect(html).toContain('15-Jul-2026');
    expect(html).toMatch(/01:40\s*PM/i);
    expect(html).toContain('Bill # S-000057');
    expect(html).toContain('M1/10');
  });
});

describe('the lines', () => {
  it('prints description, quantity and amount under the ruled headings', () => {
    render();
    expect(html).toContain('DESCRIPTION');
    expect(html).toContain('QTY');
    expect(html).toContain('AMOUNT');
    expect(html).toContain('CHKN F/RCE/S');
    expect(html).toContain('LKR 1,200.00');
    // "1.000" reads as machinery on a bill.
    expect(html).toContain('>1<');
    expect(html).not.toContain('>1.000<');
  });

  it('prints a special note under the line it belongs to', () => {
    render({
      lines: [
        {
          name: 'BEEF F/RCE/S',
          variantName: 'Large',
          quantity: '1',
          lineTotal: '1200.00',
          specialInstructions: 'no onions',
        },
      ],
    });
    expect(html).toContain('no onions');
    expect(html).toContain('Large');
    // The note sits INSIDE the line's own cell, after the name — a note that
    // floated to its own row would read as a second, unpriced item.
    const cell = html.slice(html.indexOf('BEEF F/RCE/S'), html.indexOf('</td>'));
    expect(cell).toContain('no onions');
  });
});

describe('the totals block', () => {
  it('prints the tender, total qty and the three amounts', () => {
    render();
    expect(html).toContain('*** CASH');
    expect(html).toContain('Total Qty :');
    expect(html).toContain('Bill Amount :');
    expect(html).toContain('Paid Amount :');
    expect(html).toContain('Bal. Amount :');
  });

  it('shows a DISCOUNT when one was applied, and no row when none was', () => {
    // NEGATIVE — a zero discount is noise on a guest's bill.
    render({ discount: '0.00' });
    expect(html).not.toContain('Discount');

    // POSITIVE — the same template prints it when it is real. A discount the
    // bill absorbs into the total without saying so is the failure that
    // matters: the guest cannot see what they were given.
    render({ discount: '200.00', total: '2000.00' });
    expect(html).toContain('Discount');
    // As a DEDUCTION. A discount printed as a positive in a column of charges
    // reads as one more thing the guest is being asked to pay.
    expect(html).toContain('>-LKR 200.00<');
    // …and the charges beside it are NOT negated, so the minus is specific.
    render({ discount: '200.00', serviceCharge: '220.00' });
    expect(html).toContain('>LKR 220.00<');
  });

  it('shows service charge and tax only when charged', () => {
    render({ serviceCharge: '0.00', tax: '0.00', packaging: '0.00' });
    expect(html).not.toContain('Service charge');
    expect(html).not.toContain('Tax');
    expect(html).not.toContain('Packaging');

    render({ serviceCharge: '220.00', tax: '110.00', packaging: '50.00' });
    expect(html).toContain('Service charge');
    expect(html).toContain('Tax');
    expect(html).toContain('Packaging');
  });

  it('prints a bill note when the profile carries one', () => {
    render({ note: 'Prices inclusive of service charge.' });
    expect(html).toContain('Prices inclusive of service charge.');
    render({ note: null });
    expect(html).not.toContain('Prices inclusive');
  });

  it('closes with the tenant’s footer text', () => {
    render();
    expect(html).toContain('Thank You! Come Again.');
  });
});

describe('safety', () => {
  it('escapes item names rather than letting them close a tag', () => {
    render({
      lines: [{ name: '<script>x</script>', quantity: '1', lineTotal: '1.00' }],
    });
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('escapes a hostile logo URL out of the src attribute', () => {
    render({ profile: { ...profile, logoUrl: '" onerror="alert(1)' } });
    expect(html).not.toContain('onerror="alert(1)"');
  });
});

describe('the printed page itself', () => {
  it('zeroes the page margin — killing the chrome AND the gap between pages', () => {
    render();
    /*
     * One declaration, two jobs. It removes the browser's print header and
     * footer (the page number and the about:blank URL), because with no
     * margin there is nowhere to draw them. And it is what makes a long bill
     * read as ONE receipt: the gap between page one and page two IS the page
     * margin, and on a roll that gap prints as a band of blank paper that
     * looks like the receipt was cut and restarted.
     */
    expect(html).toContain('@page{margin:0}');
  });

  it('leaves the page SIZE to the printer layer, not the markup', () => {
    render();
    /*
     * The template never bakes a page size in. The height depends on how
     * the document actually lays out — how the address wraps, whether the
     * logo loaded — which only the print window knows, so `fitPageToContent`
     * measures and injects it there (D75).
     *
     * Asserted here so nobody "fixes" a paged receipt by guessing a height
     * in the CSS: a guess that is too short truncates the bill, and one that
     * is too tall is the trailing blank paper this all exists to remove.
     */
    expect(html).not.toMatch(/@page\{[^}]*size:/);
    // POSITIVE CONTROL — an @page rule IS emitted, so the absence above is
    // about `size` specifically and not about the block failing to render.
    expect(html).toContain('@page{');
  });

  it('lets content break freely — an avoided break is a visible gap', () => {
    render();
    /*
     * The opposite of what a report wants, and deliberate. `break-inside:
     * avoid` was here to stop a line being cut at a page boundary; on a
     * continuous roll it pushes the row WHOLE onto the next page and the
     * space it vacated prints as blank paper mid-receipt. That is the gap
     * the PO photographed between "Soup of the Day" and "Vegetable Fried
     * Rice".
     *
     * With the page sized to the content there is no boundary at all, and if
     * one ever appears, an allowed break rejoins across abutting pages while
     * an avoided one leaves a hole.
     */
    expect(html).not.toContain('break-inside:avoid');
    expect(html).not.toContain('page-break-inside:avoid');
  });

  it('prints the column headings once, not per page', () => {
    render();
    // A browser repeats a thead by design — right for a report, wrong on a
    // roll, where the repeat reads as a second receipt starting.
    expect(html).toContain('thead{display:table-row-group}');
  });
});
