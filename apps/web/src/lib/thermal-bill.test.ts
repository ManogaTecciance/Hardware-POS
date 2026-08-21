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

import { vi } from 'vitest';

/*
 * Mirrors the real helper: a stored `/uploads/...` path is absolutised
 * against the API origin, and anything already absolute passes through.
 */
vi.mock('./products-api', () => ({
  resolveImageUrl: (url: string | null | undefined) =>
    !url ? null : /^(https?:\/\/|blob:|data:)/.test(url) ? url : `http://api.test${url}`,
}));

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

  it('absolutises a stored logo path against the API origin', () => {
    /*
     * D86 — an uploaded logo is stored as `/uploads/<key>`, and `/uploads` is
     * served by the API: a different origin from the web app in every
     * deployment (:4000 vs :3000 locally, api.axlopos.com vs the Amplify host
     * in production). Printed raw, the browser resolves it against the app's
     * own origin, finds nothing, and the receipt comes out with the logo
     * silently missing — no error, no broken-image icon on paper.
     */
    render({ profile: { ...profile, logoUrl: '/uploads/images/abc.webp' } });
    expect(html).toContain('src="http://api.test/uploads/images/abc.webp"');
    // NEGATIVE — the bare path must not survive into the markup.
    expect(html).not.toContain('src="/uploads/images/abc.webp"');
  });

  it('leaves an absolute logo URL alone', () => {
    render({ profile: { ...profile, logoUrl: 'https://cdn.test/logo.png' } });
    expect(html).toContain('src="https://cdn.test/logo.png"');
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
    // D86 — no "Total Qty" row: a guest counts plates, not units, and it is
    // the only figure on the receipt that is neither money nor a line they
    // ordered. Asserted negatively so it cannot drift back in.
    expect(html).not.toContain('Total Qty');
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
     * margin there is nowhere to draw them. And it closes the gap between
     * pages: that gap IS the page margin, and on a roll it prints as a band
     * of blank paper that reads as the receipt having been cut and restarted.
     */
    expect(html).toContain('@page{margin:0}');
  });

  it('leaves the page SIZE to the printer', () => {
    render();
    /*
     * D77 — no page size is declared, and this is the third position on it.
     *
     * Declaring one gets a single page that ends at the content, which is
     * what a roll wants. But `@page { size }` is a REQUEST: where the height
     * exceeds the paper the driver reports, Chrome scales the page down to
     * fit, and the bill prints correct-but-small. That happened twice on the
     * PO's printer, at 432mm and again at 223mm.
     *
     * Correct size beats one page, so the size is left to the printer and
     * the fitting is opt-in for a driver configured with a continuous roll.
     */
    expect(html).not.toMatch(/@page\{[^}]*size:/);
    expect(html).toContain('@page{');
  });

  it('carries no script and no on-page button', () => {
    render();
    /*
     * D78 — the receipt is printed from a hidden IFRAME, so there is no
     * window for a button to live in and nothing for an embedded script to
     * drive. Three rounds went into making a popup close itself; removing
     * the popup removed the problem instead.
     *
     * Asserted negatively because a stray script in a document that is
     * written into an invisible frame would run unseen.
     */
    expect(html).not.toContain('<script');
    expect(html).not.toContain('window.print()');
    expect(html).not.toContain('class="btn"');
  });

  it('fills the roll, held off the RIGHT edge only', () => {
    render();
    /*
     * Two different numbers, and conflating them cost several rounds.
     *
     * The PAGE is 78mm — the driver's own stock width (Xprinter XP-365B,
     * "USER", Maximum Size 78.7mm). Matching it means nothing is centred, so
     * no width is lost to margins before the content starts.
     *
     * The TEXT is inset 6mm from the right, because the print head stops
     * short of the paper's edge. At 78mm of text the last two characters
     * were lost — "LKR 1,450.00" printed as "LKR 1,450." and "AMOUNT" as
     * "AMOU" — which is about 3.5mm at this font size. 4mm cleared the clip
     * but left the amounts hard against the edge; 6mm gives them room.
     *
     * RIGHT only. The left has always printed cleanly from x=0, and taking
     * width off both sides is what left the band of white down the margins.
     */
    expect(html).toContain('box-sizing:border-box');
    const bodyRule = html.slice(
      html.indexOf('body{font-family'),
      html.indexOf('}', html.indexOf('body{font-family')),
    );
    expect(bodyRule).toContain('width:100%');
    expect(bodyRule).toContain('padding:0 6mm 0 0');
    // NEGATIVE — not centred, not a fixed column, and not inset on the left:
    // the three shapes that put white where the operator does not want it.
    expect(bodyRule).not.toContain('auto');
    expect(bodyRule).not.toContain('max-width');
    expect(bodyRule).not.toMatch(/padding:0 \d+mm 0 \d+mm/);
  });

  it('lets content break freely — an avoided break is a visible gap', () => {
    render();
    /*
     * `break-inside: avoid` pushes a row that does not fit WHOLE onto the
     * next page, and the space it vacated prints as blank paper mid-receipt.
     * That is the gap the PO photographed between "Soup of the Day" and
     * "Vegetable Fried Rice". With margin 0 the pages abut, so an allowed
     * break rejoins invisibly where an avoided one leaves a hole.
     */
    expect(html).not.toContain('break-inside:avoid');
    expect(html).not.toContain('page-break-inside:avoid');
  });

  it('prints the column headings once, not per page', () => {
    render();
    expect(html).toContain('thead{display:table-row-group}');
  });
});
