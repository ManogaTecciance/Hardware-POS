/**
 * The printed kitchen ticket (D153).
 *
 * A KOT on paper, for the pass that wants one in its hand rather than on a
 * screen. The layout follows the format the PO supplied, with the four
 * differences they asked for:
 *
 *   - no "KOT" heading. The paper comes off the kitchen printer; nothing else
 *     does, and the ticket number is the first thing on it anyway.
 *   - the ticket NUMBER on the left of the top line, the stamp on the right.
 *   - the table's NAME on its own, with no "Table No." label and no customer.
 *     The kitchen cooks for a table; who is sitting at it is the floor's
 *     business, and the label was a word explaining something the name already
 *     says. A takeaway, which has no table, reads "Takeaway" instead.
 *   - no "Total Items" footer, and instead the thing a cook actually needs
 *     under each line: its variant, its modifiers and its special
 *     instructions. A count of lines tells the kitchen nothing it cannot see;
 *     "no chilli" is the whole reason the paper exists.
 *
 * ## Rendered as HTML, printed through the same iframe as every other document
 *
 * `printReceipt` (D78) owns the frame, the geometry, the image wait and the
 * cleanup, so this file is a pure string function plus a one-line caller. That
 * split is what makes the format testable without a printer: every assertion
 * below is about the markup, and the only untested part is the browser dialog.
 *
 * ## Geometry
 *
 * The tenant's own roll (D99), read from the cached document profile, so a KOT
 * and a bill come off the same paper at the same width. `printReceipt` reads
 * the geometry back out of the document's meta tags, so the width this lays
 * out at and the width it prints at cannot disagree.
 */

import { getCachedDocumentProfile } from '../document-template-service';
import { sendLabel } from './labels';
import { printReceipt } from '../receipt-print';
import {
  billBodyGeometryCss,
  billGeometryMetaTags,
  resolveBillGeometry,
  type BillGeometry,
} from '../thermal-bill-geometry';

/** One line of the ticket, as the board already holds it. */
export interface KotPrintItem {
  menuItemName: string;
  /** D46 — the operator-selected variation, printed verbatim. */
  variantName?: string | null;
  /** Decimal string off the wire, e.g. "2.000". */
  quantity: string;
  modifierNames?: readonly string[];
  specialInstructions?: string | null;
}

export interface KotPrintInput {
  ticketNumber: string;
  /** The table, tab or area. Null for a ticket with nowhere recorded. */
  placeLabel?: string | null;
  /** Which round of the order this ticket cut. */
  roundNumber?: number | null;
  /** The station this ticket belongs to (D152). Null for a D147-window row. */
  stationName?: string | null;
  orderNumber?: string | null;
  /** When the ticket reached the kitchen. */
  createdAt: string | Date;
  items: readonly KotPrintItem[];
}

function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * "2.000" reads as 2 on paper.
 *
 * The wire carries a decimal string because a kitchen can be sent 0.5 of
 * something sold by weight, so the fraction has to survive when there is one.
 * Trailing zeros are noise on a ticket a cook reads at arm's length.
 */
export function formatKotQuantity(quantity: string): string {
  const n = Number(quantity);
  if (!Number.isFinite(n)) return String(quantity);
  return String(Number(n.toFixed(3)));
}

/**
 * The line under a dish: its variation, then its modifiers, then what the
 * guest asked for in words.
 *
 * Returned as a list rather than one joined string so the caller can put the
 * instruction on its own line — it is prose, it is the longest of the three,
 * and running it on after a comma is how it gets skimmed past.
 */
export function kotItemNotes(item: KotPrintItem): string[] {
  const notes: string[] = [];
  const extras = [item.variantName, ...(item.modifierNames ?? [])].filter(
    (v): v is string => typeof v === 'string' && v.trim() !== '',
  );
  if (extras.length > 0) notes.push(extras.join(', '));
  const instruction = item.specialInstructions?.trim();
  // Prefixed, because an instruction is an order and a modifier is a choice.
  // On paper the two look alike until one of them is labelled.
  if (instruction) notes.push(`** ${instruction}`);
  return notes;
}

/** The stamp on the right of the top line: the format of the PO's sample. */
export function formatKotStamp(at: string | Date): string {
  const d = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(d.getTime())) return '';
  const date = d.toLocaleDateString('en-GB', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
  const time = d.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
  return `${date} ${time}`;
}

function css(g: BillGeometry): string {
  return `
@page{margin:0}
*{box-sizing:border-box}
${billBodyGeometryCss(g)}
/*
 * The SAME stack the bill prints in (PO). A thermal roll is a fixed-pitch
 * device and every other document off it is monospace, so a sans-serif KOT
 * read as a different system's paper — and the columns stopped lining up
 * against the bill beside it in the same clip.
 *
 * Copied rather than imported: the bill builds one CSS string and exports
 * none of it, and reaching into that for a font would couple this document to
 * the bill's whole layout. The two are pinned together by a test instead, so a
 * change to either is caught rather than silently diverging.
 */
body{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#000;font-size:12px;line-height:1.35}
.top{display:flex;justify-content:space-between;gap:8px;font-size:12px}
.top .num{font-weight:700}
hr{border:0;border-top:1px solid #000;margin:5px 0}
.where{font-size:13px;font-weight:700;margin:4px 0}
.where .sub{display:block;font-size:11px;font-weight:400;margin-top:1px}
table{width:100%;border-collapse:collapse}
th{font-size:11px;font-weight:700;text-align:left;padding:2px 0}
th.n{width:48px;text-align:center}
th.q{width:34px;text-align:right}
td{vertical-align:top;padding:3px 0;font-size:12px}
td.n{text-align:center}
td.q{text-align:right;font-weight:700}
.note{font-size:11px;padding-left:6px}
/*
 * The instruction is the one thing on the ticket that changes what the cook
 * DOES, so it is the one thing set apart. Bold rather than a colour: this
 * prints on a monochrome thermal head, where a colour is simply grey.
 */
.note.instruction{font-weight:700}
`.trim();
}

/**
 * The ticket, as HTML. Pure — no DOM, no clock, no network — so the whole
 * format is assertable from a unit test.
 */
export function renderKitchenTicket(input: KotPrintInput, geometry?: BillGeometry): string {
  const g = geometry ?? resolveBillGeometry(getCachedDocumentProfile());

  const rows = input.items
    .map((item, index) => {
      // The `** ` prefix is what `kotItemNotes` marks an instruction with, so
      // the class follows the content rather than the position — a dish with
      // an instruction and no modifiers has it first, not last.
      const notes = kotItemNotes(item)
        .map(
          (note) =>
            `<div class="note${note.startsWith('** ') ? ' instruction' : ''}">${esc(note)}</div>`,
        )
        .join('');
      return `<tr><td class="n">${index + 1}</td><td>${esc(item.menuItemName)}${notes}</td><td class="q">${esc(
        formatKotQuantity(item.quantity),
      )}</td></tr>`;
    })
    .join('');

  /*
   * The second line of the "where" block. The round matters to a kitchen
   * reading two tickets for one table an hour apart, and the station says
   * which pass the paper belongs to when a branch runs several. Both are
   * omitted rather than printed empty — a takeaway has no table, and a
   * D147-window ticket has no station.
   */
  const sub = [
    input.orderNumber ? esc(input.orderNumber) : '',
    input.roundNumber != null ? sendLabel(input.roundNumber) : '',
    input.stationName ? esc(input.stationName) : '',
  ]
    .filter(Boolean)
    .join(' · ');

  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(
    input.ticketNumber,
  )}</title>${billGeometryMetaTags(g)}<style>${css(g)}</style></head>
<body>
<div class="top"><span class="num">${esc(input.ticketNumber)}</span><span>${esc(
    formatKotStamp(input.createdAt),
  )}</span></div>
<hr>
<div class="where">${esc(input.placeLabel ?? 'Takeaway')}${
    sub ? `<span class="sub">${sub}</span>` : ''
  }</div>
<hr>
<table>
<thead><tr><th class="n">Item No.</th><th>Item Name</th><th class="q">Qty.</th></tr></thead>
<tbody>${rows}</tbody>
</table>
<hr>
</body></html>`;
}

/** Render and print. The button on a kitchen card calls exactly this. */
export function printKitchenTicket(input: KotPrintInput): void {
  printReceipt(renderKitchenTicket(input));
}
