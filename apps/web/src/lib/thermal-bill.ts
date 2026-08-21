import type { DocumentProfile } from './document-template-service';
import { formatMoney } from './restaurant/labels';

/**
 * D72 — the printed restaurant bill.
 *
 * Modelled on the thermal receipt the PO supplied: a centred logo, then the
 * address, then the phone numbers, then a ruled DESCRIPTION / QTY / AMOUNT
 * table, the tender, and the totals block. It is deliberately a narrow
 * monospaced column — 80 mm paper is what a restaurant till prints on, and a
 * layout that only reads well on A4 gets folded in half by the printer.
 *
 * Everything above the lines comes from the tenant's document profile
 * (Settings → Documents), including the logo, so a workspace brands its own
 * bill without a code change. Nothing is substituted when a field is unset:
 * an empty header is visibly wrong to whoever is about to print it, where a
 * plausible-looking default is not (D54).
 */

export interface ThermalBillLine {
  name: string;
  variantName?: string | null;
  quantity: string;
  lineTotal: string;
  /** Printed under the line, indented — "no onions". */
  specialInstructions?: string | null;
}

export interface ThermalBillInput {
  profile: DocumentProfile;
  /** Falls back to the branch name when the profile carries no company name. */
  fallbackName?: string;
  currency?: string;
  /** "Bill # 57" — the sale or order number. */
  documentNumber: string;
  /** "M1/10" in the reference bill: the table, or Takeaway. */
  placeLabel?: string | null;
  servedBy?: string | null;
  issuedAt: Date;
  /** Marks a re-print so a duplicate cannot be passed off as the original. */
  copyLabel?: string | null;

  lines: ThermalBillLine[];
  subtotal: string;
  discount?: string | null;
  serviceCharge?: string | null;
  packaging?: string | null;
  tax?: string | null;
  total: string;
  paid: string;
  balance: string;
  /** One row per tender, printed as the reference bill does: `*** CASH`. */
  payments?: { method: string; amount: string }[];
  /** Free text under the totals — the guest-facing note for THIS bill. */
  note?: string | null;
}

/** 80 mm roll ≈ 302 CSS px at 96 dpi. The printable column, in pixels. */
export const RECEIPT_WIDTH_PX = 302;
/** …and in millimetres, which is the unit `@page` wants. */
export const RECEIPT_WIDTH_MM = 80;

const CSS = `
:root { color-scheme: light; }
/*
 * margin: 0 does two jobs, and both are the point of this block.
 *
 * 1. It removes the browser's own print header and footer — the page number
 *    and the about:blank URL Chrome draws in the page margin. With no margin
 *    there is nowhere for that chrome to be drawn, and CSS has no other
 *    lever over it.
 *
 * 2. It is what makes a long bill READ as one continuous receipt. The gap
 *    between one page and the next IS the page margin: on a roll, a default
 *    margin prints as a band of blank paper mid-bill that looks like the
 *    receipt has been cut and restarted. At zero, page two carries on
 *    exactly where page one stopped.
 *
 * The page is deliberately NOT given an explicit size. An earlier attempt
 * measured the document and wrote size: 80mm <height>mm so the whole bill
 * was one page — which browsers honour by SCALING that page down onto the
 * physical paper, so a long order printed correct-but-unreadably-small. The
 * paper size belongs to the printer; the only thing this document asserts is
 * that it wastes none of it.
 */
@page{margin:0}
/*
 * NOTHING avoids a page break — deliberately, and this is the opposite of
 * what a report wants.
 *
 * break-inside: avoid was here first, to stop a line being cut in half at
 * the page boundary. On a continuous roll that protection costs more than it
 * buys: a row that does not fit in what is left of the page is pushed WHOLE
 * onto the next one, and the space it vacated prints as a band of blank
 * paper mid-receipt. That is exactly the gap the PO photographed, between
 * "Soup of the Day" and "Vegetable Fried Rice".
 *
 * With margin: 0 the pages abut, so the split this used to prevent is
 * invisible: the top half of a line prints at the end of one page and the
 * bottom half at the start of the next, and on continuous paper they meet.
 * An avoided break is a gap you can see; an allowed one is not.
 */
/*
 * Stop the column headings repeating at the top of every page. A browser
 * repeats a thead by design, which is right for a report and wrong here: on
 * a continuous roll it prints DESCRIPTION / QTY / AMOUNT again in the middle
 * of the bill, and a guest reading it sees a second receipt starting.
 * table-row-group demotes the thead to an ordinary group, printed once.
 */
thead{display:table-row-group}
html,body{height:auto}
body{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;max-width:302px;margin:0 auto;padding:12px;color:#000;background:#fff}
.c{text-align:center}
.logo{display:block;margin:0 auto 6px;max-width:180px;max-height:110px;object-fit:contain}
h1{font-size:15px;margin:0 0 2px;letter-spacing:.02em}
.addr{font-size:11px;line-height:1.35;margin:0 0 1px;white-space:pre-line}
.meta{font-size:11px;line-height:1.5;margin-top:8px}
.meta .row{display:flex;justify-content:space-between;gap:8px}
hr{border:0;border-top:1px dashed #000;margin:6px 0}
table{width:100%;border-collapse:collapse;font-size:11px}
th{text-align:left;font-weight:normal;padding-bottom:2px}
th.q,td.q{text-align:center;width:34px}
th.a,td.a{text-align:right;width:74px;white-space:nowrap}
td{padding:2px 0;vertical-align:top}
.note{display:block;padding-left:10px;font-size:10px;font-style:italic}
.tot{font-size:11px;line-height:1.6;margin-top:2px}
.tot .row{display:flex;justify-content:space-between;gap:12px}
.tot .row span:last-child{white-space:nowrap}
.tot .g{font-weight:bold}
.pay{font-size:11px;margin:4px 0}
.pay .row{display:flex;justify-content:space-between}
.ft{margin-top:12px;font-size:11px;white-space:pre-line}
.copy{margin-top:4px;font-size:11px;font-weight:bold}
.btn{display:block;margin:0 auto 10px;padding:8px 16px;cursor:pointer;font:inherit}
@media print{.btn{display:none}body{padding:6px 10px;max-width:none}}
`;

/**
 * Escapes for BOTH text and attribute contexts.
 *
 * The quote pair is not optional here, unlike in the older receipt helpers
 * where every interpolation lands in a text node: this template puts the
 * profile's logo URL inside `src="…"`, and a value containing a double quote
 * closes the attribute and starts a new one. Caught by the test below, which
 * feeds it `" onerror="alert(1)`.
 */
function esc(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** "2.000" reads as machinery on a bill; "2" and "0.5" read as plates. */
function qty(q: string): string {
  return String(Number(q));
}

function money(value: string, currency?: string): string {
  return formatMoney(Number(value), currency);
}

/** A row that is only printed when it carries a number. */
function optional(
  label: string,
  value: string | null | undefined,
  currency?: string,
  /** Deductions print with a leading minus — a discount shown as a positive
   *  in a column of charges reads as one more thing the guest is paying for. */
  negative = false,
): string {
  if (value == null || Number(value) === 0) return '';
  const amount = money(value, currency);
  return `<div class="row"><span>${esc(label)}</span><span>${negative ? '-' : ''}${esc(
    amount,
  )}</span></div>`;
}

export function renderThermalBill(input: ThermalBillInput): string {
  const p = input.profile;
  const name = p.companyName || input.fallbackName || '';

  /*
   * The logo is an <img>, and print windows race image decoding: an
   * unfinished image prints as a blank box. `openPrintWindow` waits for
   * load/error before calling print(), which is why this markup carries no
   * inline onload of its own.
   */
  /*
   * The logo replaces the name rather than sitting above it: on the bill this
   * imitates, the mark carries the wordmark, and printing both gives a
   * duplicated brand. A workspace with a wordless logo puts its name in the
   * logo or in the address line — which is a choice they can see and fix,
   * unlike a name silently printed twice.
   */
  const logo = p.logoUrl
    ? `<img class="logo" src="${esc(p.logoUrl)}" alt="${esc(name)}">`
    : '';

  const contact = [p.phone, p.email].filter(Boolean).map((v) => esc(v)).join('<br>');

  const totalQty = input.lines.reduce((n, l) => n + Number(l.quantity), 0);

  const rows = input.lines
    .map((l) => {
      const label =
        esc(l.name) + (l.variantName ? ` <span class="note">${esc(l.variantName)}</span>` : '');
      const note = l.specialInstructions
        ? `<span class="note">${esc(l.specialInstructions)}</span>`
        : '';
      return `<tr><td>${label}${note}</td><td class="q">${esc(qty(l.quantity))}</td><td class="a">${esc(
        money(l.lineTotal, input.currency),
      )}</td></tr>`;
    })
    .join('');

  const tenders = (input.payments ?? [])
    .map(
      (t) =>
        `<div class="row"><span>*** ${esc(t.method.replace(/_/g, ' '))}</span><span>${esc(
          money(t.amount, input.currency),
        )}</span></div>`,
    )
    .join('');

  const stamp = input.issuedAt;
  // "15-Jul-2026", as the reference bill prints it — `en-GB` gives
  // "15 Jul 2026", so the separators are substituted rather than hand-rolled.
  const date = stamp
    .toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
    .replace(/ /g, '-');
  const time = stamp.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });

  return `<!doctype html><html><head><meta charset="utf-8"><title>Bill ${esc(
    input.documentNumber,
  )}</title><style>${CSS}</style></head>
<body>
<button class="btn" onclick="window.print()">Print</button>
<div class="c">
${logo}
${!logo && name ? `<h1>${esc(name)}</h1>` : ''}
${p.addressLine ? `<p class="addr">${esc(p.addressLine)}</p>` : ''}
${contact ? `<p class="addr">${contact}</p>` : ''}
${p.taxNumber ? `<p class="addr">VAT ${esc(p.taxNumber)}</p>` : ''}
${input.copyLabel ? `<p class="copy">${esc(input.copyLabel)}</p>` : ''}
</div>

<div class="meta">
${input.servedBy ? `<div>Served By: ${esc(input.servedBy)}</div>` : ''}
<div class="row"><span>${esc(date)}</span><span>${esc(time)}</span></div>
<div class="row"><span>Bill # ${esc(input.documentNumber)}</span><span>${esc(
    input.placeLabel ?? '',
  )}</span></div>
</div>

<hr>
<table>
<thead><tr><th>DESCRIPTION</th><th class="q">QTY</th><th class="a">AMOUNT</th></tr></thead>
<tbody>${rows}</tbody>
</table>
<hr>

${tenders ? `<div class="pay">${tenders}</div><hr>` : ''}

<div class="tot">
<div class="row"><span>Total Qty :</span><span>${esc(totalQty.toFixed(2))}</span></div>
<div class="row"><span>Subtotal</span><span>${esc(money(input.subtotal, input.currency))}</span></div>
${optional('Discount', input.discount, input.currency, true)}
${optional('Service charge', input.serviceCharge, input.currency)}
${optional('Packaging', input.packaging, input.currency)}
${optional('Tax', input.tax, input.currency)}
<div class="row g"><span>Bill Amount :</span><span>${esc(money(input.total, input.currency))}</span></div>
<div class="row"><span>Paid Amount :</span><span>${esc(money(input.paid, input.currency))}</span></div>
<div class="row"><span>Bal. Amount :</span><span>${esc(money(input.balance, input.currency))}</span></div>
</div>

${input.note ? `<hr><div class="ft">${esc(input.note)}</div>` : ''}
${p.footerText ? `<div class="ft c">${esc(p.footerText)}</div>` : ''}
</body></html>`;
}
