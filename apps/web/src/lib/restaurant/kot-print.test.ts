/**
 * The printed kitchen ticket (D153).
 *
 * The renderer is pure, so the whole format is assertable here and the only
 * thing left untested is the browser's own print dialog. That matters more
 * than usual for this document: nobody reviews a KOT on screen. It goes
 * straight from a button to a thermal head to a cook, and a line that failed
 * to print is discovered when the plate is wrong.
 *
 * Every assertion below is paired. The four things the PO asked to REMOVE are
 * absences, and an absence asserted against a fixture that never had the thing
 * proves nothing (D30) — so each fixture carries the value that would print if
 * the renderer changed its mind: a customer name on the input type would not
 * compile, so the guard there is the type; for the rest the fixture supplies
 * real modifiers, real instructions and a real item count.
 */
import { describe, expect, it } from 'vitest';

import { GEOMETRY_META, resolveBillGeometry } from '../thermal-bill-geometry';

import {
  formatKotQuantity,
  formatKotStamp,
  kotItemNotes,
  renderKitchenTicket,
  type KotPrintInput,
} from './kot-print';

const TICKET: KotPrintInput = {
  ticketNumber: 'KOT-000027',
  placeLabel: 'Table 1',
  roundNumber: 2,
  stationName: 'Grill',
  orderNumber: 'RO-000026',
  createdAt: '2026-08-04T18:13:00.000Z',
  items: [
    { menuItemName: 'Baigan ka Bharta', quantity: '1.000' },
    {
      menuItemName: 'Chicken Lollypop',
      quantity: '2.000',
      variantName: 'LARGE',
      modifierNames: ['Extra spicy', 'No garlic'],
      specialInstructions: 'Guest is allergic to peanuts',
    },
    { menuItemName: 'Coriander Chicken Curry', quantity: '1.000' },
  ],
};

/** The rendered text, tags stripped, whitespace collapsed — what a cook sees. */
function asText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<head[\s\S]*?<\/head>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('what the ticket prints', () => {
  it('leads with the ticket number on the left and the stamp on the right', () => {
    const html = renderKitchenTicket(TICKET);

    // The two ends of the top line, in source order, so "left" and "right" is
    // a claim about the markup and not only about the CSS beside it.
    const top = /<div class="top"><span class="num">([^<]*)<\/span><span>([^<]*)<\/span><\/div>/.exec(
      html,
    );
    expect(top).not.toBeNull();
    expect(top![1]).toBe('KOT-000027');
    expect(top![2]).toBe(formatKotStamp(TICKET.createdAt));
    // …and the line really does put them at opposite ends.
    expect(html).toContain('justify-content:space-between');
  });

  it('names the table, and the order, round and station under it', () => {
    const text = asText(renderKitchenTicket(TICKET));

    // The name alone — the "Table No." label is gone, and asserted gone, or
    // the rename would pass on a `toContain` of the name inside the old label.
    expect(text).toContain('Table 1');
    expect(text).not.toMatch(/table no/i);
    expect(text).toContain('RO-000026 · Round 2 · Grill');
  });

  it('lists every dish with its number and quantity', () => {
    const text = asText(renderKitchenTicket(TICKET));

    expect(text).toContain('Item No. Item Name Qty.');
    expect(text).not.toContain('Sl.No');
    // Numbered from one, in the order the round was keyed.
    expect(text).toContain('1 Baigan ka Bharta');
    expect(text).toContain('3 Coriander Chicken Curry');
    // Quantity reads as a number, not as the wire's decimal string.
    expect(text).toContain('2');
    expect(text).not.toContain('2.000');
  });

  it('prints the modifiers and the instruction UNDER the dish they belong to', () => {
    const html = renderKitchenTicket(TICKET);

    /*
     * The point of the whole document. Asserted inside the row rather than
     * anywhere in the page: a note that printed at the foot of the ticket
     * would satisfy a page-wide `toContain` while telling the cook nothing
     * about WHICH dish is missing the garlic.
     */
    const row = /<tr><td class="n">2<\/td><td>([\s\S]*?)<\/td><td class="q">/.exec(html);
    expect(row).not.toBeNull();
    const cell = asText(row![1]!);
    expect(cell).toContain('Chicken Lollypop');
    expect(cell).toContain('LARGE, Extra spicy, No garlic');
    expect(cell).toContain('Guest is allergic to peanuts');

    // The instruction is set apart from the choices, because the two read
    // alike on paper until one of them is marked.
    expect(row![1]).toContain('class="note instruction"');
  });

  it('NEGATIVE — a dish with nothing to add carries no empty note line', () => {
    const html = renderKitchenTicket(TICKET);

    // The control for the test above: rows 1 and 3 have no modifiers and no
    // instruction, so a renderer emitting a blank note for every line would
    // be caught here rather than looking correct on the fixture that has one.
    const plain = /<tr><td class="n">1<\/td><td>([\s\S]*?)<\/td><td class="q">/.exec(html)![1];
    expect(plain).toBe('Baigan ka Bharta');
    expect(plain).not.toContain('class="note');
  });
});

describe('the four things the PO asked to leave off', () => {
  it('prints no "KOT" heading', () => {
    const html = renderKitchenTicket(TICKET);

    // The title tag carries the number for the print dialog, so the check is
    // about the BODY: no heading element, and no bare "KOT" in the text.
    const body = html.slice(html.indexOf('<body>'));
    expect(body).not.toMatch(/<h[1-6]/);
    expect(asText(body)).not.toMatch(/(^|\s)KOT(\s|$)/);
    // Positive control — the ticket number, which begins "KOT-", is still on
    // it, so the absence above is about the heading and not about an empty
    // document.
    expect(asText(body)).toContain('KOT-000027');
  });

  it('prints no customer, and cannot be given one', () => {
    const text = asText(renderKitchenTicket(TICKET));

    expect(text).not.toMatch(/customer/i);
    /*
     * The real guard is the input type: `KotPrintInput` has no customer field,
     * so a future caller cannot pass one in and have it quietly appear. This
     * asserts the shape rather than trusting the absence — @ts-expect-error
     * fails the build if the property ever becomes valid.
     */
    // @ts-expect-error — a customer has no place on a kitchen ticket.
    const withCustomer: KotPrintInput = { ...TICKET, customerName: 'Anurag Ghosh' };
    expect(asText(renderKitchenTicket(withCustomer))).not.toContain('Anurag Ghosh');
  });

  it('prints no "Total Items" footer', () => {
    const text = asText(renderKitchenTicket(TICKET));

    expect(text).not.toMatch(/total items/i);
    // The fixture has three lines, so a renderer that footed the ticket with a
    // count would print "3" on its own after the last dish. The last thing on
    // the ticket is the last dish.
    expect(text.trim().endsWith('Coriander Chicken Curry 1')).toBe(true);
  });
});

describe('the shapes a real kitchen sends', () => {
  it('says Takeaway when there is no table', () => {
    const text = asText(
      renderKitchenTicket({ ...TICKET, placeLabel: null, roundNumber: null, orderNumber: null }),
    );

    // Not an empty line: a cook holding paper with a blank where the table
    // goes does not know whether it is takeaway or a bug.
    expect(text).toContain('Takeaway');
    // …and the sub-line is dropped rather than printed as separators.
    expect(text).not.toContain('·');
  });

  it('omits the station for a ticket that has none, without printing null', () => {
    const text = asText(renderKitchenTicket({ ...TICKET, stationName: null }));

    expect(text).toContain('RO-000026 · Round 2');
    expect(text).not.toContain('null');
    expect(text).not.toContain('Round 2 ·');
  });

  it('escapes a dish name that contains markup', () => {
    const html = renderKitchenTicket({
      ...TICKET,
      items: [{ menuItemName: '<script>alert(1)</script>', quantity: '1' }],
    });

    // This document is written straight into an iframe, so an unescaped name
    // is script execution, not a cosmetic defect.
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('carries the geometry so the frame and the page agree on the width', () => {
    const html = renderKitchenTicket(TICKET);

    /*
     * D99 — `printReceipt` reads these back out of the document. Without them
     * it lays out at the default and prints at the tenant's roll.
     *
     * Asserted through the SHIPPED names and the SHIPPED reader, not through
     * strings retyped here: a test that spelled the meta names itself would
     * keep passing after a rename on either side, which is the whole failure
     * mode a geometry carried in markup has.
     */
    for (const name of [
      GEOMETRY_META.pageWidthMm,
      GEOMETRY_META.leftInsetMm,
      GEOMETRY_META.rightInsetMm,
    ]) {
      expect(html).toContain(`<meta name="${name}"`);
    }

    /*
     * And the NUMBERS are the ones it laid out with, not a second set. Given an
     * explicit geometry the document must carry that one — a renderer that
     * emitted the default regardless would satisfy every "contains a meta tag"
     * check above while printing a 78mm page on a 58mm roll.
     */
    const narrow = resolveBillGeometry({
      billPaperWidthMm: 58,
      billLeftInsetMm: 2,
      billRightInsetMm: 4,
    });
    const onNarrow = renderKitchenTicket(TICKET, narrow);
    expect(onNarrow).toContain(`<meta name="${GEOMETRY_META.pageWidthMm}" content="58">`);
    expect(onNarrow).toContain(`<meta name="${GEOMETRY_META.leftInsetMm}" content="2">`);
    // …and the body really lays out at it, so the meta is not decoration.
    expect(onNarrow).toContain('58');
    expect(onNarrow).not.toContain(`content="${narrow.pageWidthMm + 1}"`);
  });
});

describe('the KOT and the bill are the same document family', () => {
  it('prints in the SAME font stack the bill does', async () => {
    /*
     * PO: "use the same font as the font used when printing the receipt/bill".
     *
     * A thermal roll is a fixed-pitch device and every other document off it is
     * monospace, so a sans-serif KOT read as another system's paper — and its
     * columns stopped lining up against the bill beside it in the same clip.
     *
     * The bill exports no CSS, so the stack is duplicated in source. That is
     * exactly why this test reads BOTH files and compares them: a font changed
     * on one side and not the other is the silent divergence the duplication
     * invites, and nothing else in either suite would notice.
     */
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const lib = join(process.cwd(), 'src', 'lib');

    const stackOf = (source: string): string | null =>
      /body\{font-family:([^;]+);/.exec(source)?.[1] ?? null;

    const billStack = stackOf(readFileSync(join(lib, 'thermal-bill.ts'), 'utf8'));
    const kotStack = stackOf(readFileSync(join(lib, 'restaurant', 'kot-print.ts'), 'utf8'));

    // FAIL rather than pass on a rename: a regex that matched nothing would
    // otherwise compare null to null and report agreement.
    expect(billStack, 'the bill body font was not found — this test read nothing').not.toBeNull();
    expect(kotStack, 'the KOT body font was not found — this test read nothing').not.toBeNull();
    expect(kotStack).toBe(billStack);
    // And it really is the monospace stack, not two matching sans defaults.
    expect(kotStack).toContain('monospace');

    // The rendered document carries it, so the agreement above is about what
    // prints and not only about what the source says.
    expect(renderKitchenTicket(TICKET)).toContain(`font-family:${kotStack}`);
  });
});

describe('the helpers', () => {
  it('reads a wire quantity as a number, keeping a real fraction', () => {
    expect(formatKotQuantity('1.000')).toBe('1');
    expect(formatKotQuantity('2.500')).toBe('2.5');
    expect(formatKotQuantity('0.250')).toBe('0.25');
    // Anything unparseable is printed as it arrived rather than as NaN.
    expect(formatKotQuantity('' as string)).toBe('0');
    expect(formatKotQuantity('two')).toBe('two');
  });

  it('orders the notes: what was chosen, then what was asked for', () => {
    expect(
      kotItemNotes({
        menuItemName: 'x',
        quantity: '1',
        variantName: 'LARGE',
        modifierNames: ['No ice'],
        specialInstructions: 'Serve last',
      }),
    ).toEqual(['LARGE, No ice', '** Serve last']);

    // Blank and whitespace-only values are not notes.
    expect(
      kotItemNotes({
        menuItemName: 'x',
        quantity: '1',
        variantName: '',
        modifierNames: [],
        specialInstructions: '   ',
      }),
    ).toEqual([]);

    // An instruction with no choices still leads with the marker, so the class
    // that styles it cannot depend on the note's position.
    expect(
      kotItemNotes({ menuItemName: 'x', quantity: '1', specialInstructions: 'No chilli' }),
    ).toEqual(['** No chilli']);
  });

  it('stamps the date and the time, and nothing for a broken one', () => {
    expect(formatKotStamp('2026-08-04T18:13:00.000Z')).toMatch(
      /^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2} (AM|PM)$/,
    );
    expect(formatKotStamp('not a date')).toBe('');
  });
});
