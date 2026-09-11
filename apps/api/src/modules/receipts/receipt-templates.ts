/**
 * Printable HTML templates. Each returns a complete standalone document with
 * inline print CSS and a screen-only Print button (browser print for v1).
 */
import {
  CREDIT_METHOD_LABEL,
  formatCurrency,
  formatDateTimeInTimeZone,
  paymentMethodLabel,
  taxRateLabel,
} from '@hardware-pos/shared';

export interface ReceiptLine {
  name: string;
  /** D123 (4.6) — "Promotion: <name>", printed under the item. Null when none. */
  promotionNote: string | null;
  /**
   * NOT printed. The customer receipt carried the SKU under every item name
   * until 2026-09-08; it is an internal identifier and a customer has no use
   * for it on an 80mm slip, where the width it costs is real.
   *
   * The field STAYS because `toReceiptContent` stores this object as the
   * receipt's permanent record — dropping it would rewrite what an archived
   * receipt knows about the line, which is a data change dressed up as a
   * display fix. The A4 keeps its own SKU column behind `documents.showSku`.
   */
  sku: string | null;
  /**
   * D134d (`6.5`) — already FORMATTED by `saleLineQuantity`, so `0.75 kg`
   * reaches the paper as one string. An 80mm receipt has no Unit column.
   */
  quantity: string;
  unitPrice: number;
  discountAmount: number;
  /** How a per-unit discount was arrived at, so the printed figure can be checked. */
  discountBasis?: 'LINE' | 'UNIT';
  discountValue?: number | null;
  lineTotal: number;
}

export interface CustomerReceiptData {
  storeName: string;
  saleNumber: string;
  dateTime: string;
  documentType: string | null;
  /**
   * The sale was VOIDED. Stamped across the receipt so a reprint cannot be
   * passed off as proof of a live sale — the reason a voided sale is
   * reprintable at all is the paper trail, not the paperwork.
   *
   * Optional: every caller predating this prints exactly what it printed
   * before, and `undefined` is the same as not voided.
   */
  voided?: boolean;
  customerName: string | null;
  currency: string;
  items: ReceiptLine[];
  subtotal: number;
  totalDiscount: number;
  /** D123 (4.6) — the promotional part of `totalDiscount`, printed separately. */
  promotionDiscount: number;
  orderDiscount: number;
  taxAmount: number;
  /**
   * D122 (3.12) — per-rate rows, or empty when the document should print
   * exactly what it printed before: a single-rate sale, a restaurant Sale (no
   * lines) or a sale predating 3.8.
   */
  taxBreakdown?: { ratePercent: number; taxAmount: number }[];
  total: number;
  paidAmount: number;
  balanceAmount: number;
  paymentStatus: string;
  /**
   * D162 — cash actually handed over, when it exceeded the total.
   *
   * Optional, and absent on every document that does not have one: a card
   * sale, a credit sale, a restaurant bill, and every receipt REPRINTED
   * later (the tender is not stored, so a reprint cannot know it). Absent
   * means the receipt prints exactly as it did before this decision.
   *
   * This is a RECEIPT fact, not a money fact. `paidAmount` is still what
   * settled the sale and `balanceAmount` is still what is owed — writing
   * the tender into either would put a walk-in customer on the debtors
   * list (`credit.service` sums `balanceAmount > 0`) and overstate the
   * drawer in the dashboard's payment-method breakdown.
   */
  amountTendered?: number;
  payments: { method: string; amount: number }[];
  footer: string;
}

/**
 * D162/D164 — the change owed back, or null when there is none to print.
 *
 * The caller passes only what it observed — the amount handed over — so the
 * change is derived here and cannot contradict the amounts printed beside it.
 *
 * One guard covers all three cases that must print nothing: exact money
 * (change 0), an under-tender (negative — that is a balance owed, not change)
 * and a tender a fraction of a cent over, where "Rs. 0.00" is worse than
 * silence. A card sale, a credit sale, a restaurant bill and every REPRINT
 * arrive with no tender at all and take the same path.
 */
function changeFor(d: CustomerReceiptData): number | null {
  const tendered = d.amountTendered;
  if (tendered == null || !Number.isFinite(tendered)) return null;
  const change = round2(tendered - d.total);
  return change > 0 ? change : null;
}

function row(label: string, amount: number, currency: string): string {
  return `<div class="row"><span>${esc(label)}</span><span>${money(amount, currency)}</span></div>`;
}

/**
 * D164 — what the customer actually needs to read, and nothing twice.
 *
 * ## The report
 *
 * After D162/D163 a cash sale with change printed SEVEN rows, three of which
 * carried the same number:
 *
 *     Total 3,200 | Paid 3,200 | Balance 0.00
 *     Cash received 3,500 | Change 300 | PAID | Cash 3,200
 *
 * `Paid` equals the total on any settled sale, `Balance` is 0.00 by definition
 * when it is, and the trailing `Cash` row is the payment breakdown repeating
 * the total a third time. The two figures the customer came for — what they
 * handed over and what they get back — were buried among five that told them
 * nothing.
 *
 * ## What is printed instead
 *
 * On an over-tendered cash sale, four rows:
 *
 *     Total | Cash | Balance | Status
 *
 * `Cash` is what was handed over; `Balance` is what comes back. On this
 * receipt there is nothing owed, so `Balance` is unambiguous — and it is the
 * word the PO asked for.
 *
 * ## What is NOT changed
 *
 * Every other receipt keeps `Paid` / `Balance` and its full payment breakdown,
 * because there `Balance` means money still OWED and the breakdown is the only
 * record of how a split or credit sale was settled. A restaurant bill, a card
 * sale, a credit sale and every reprint are byte-for-byte as before.
 *
 * ## Only a single-payment sale takes the short layout
 *
 * On a SPLIT tender the change is not `tendered — total`: the cash covers
 * only its own share, so that subtraction is meaningless and would print a
 * negative. The till never sends a tender for a split (it is sent only in
 * single-method CASH mode), so the condition states what is already true
 * rather than guarding a case the caller can reach.
 *
 * A split therefore keeps `Paid` / `Balance` and its full breakdown, which
 * is the only record of how it was settled.
 */
/*
 * D167 — the wording is the restaurant bill's, because it is the trade's.
 *
 * `thermal-bill.ts` has printed `Bill Amount` / `Paid Amount` / `Bal. Amount`
 * on every food-service slip since it was written, and a Sri Lankan customer
 * reads those three lines on any till roll they are handed. The retail
 * receipt said `Total` / `Paid` / `Balance` — correct English, and not what
 * the paper in this market says.
 *
 * Both layouts now use the same three labels, which is the other gain: the
 * short over-tender layout and the ordinary one read identically, so a
 * cashier is not learning two receipts.
 *
 * The restaurant renderer appends ` :` to each label. That is NOT copied:
 * this receipt puts a colon on none of its other rows (Subtotal, Tax,
 * Status), and three colons among seven rows is worse than none.
 */
function settlementRows(d: CustomerReceiptData, paymentRows: string): string {
  const status = `<div class="row"><span>Status</span><span>${esc(d.paymentStatus)}</span></div>`;
  const change = changeFor(d);

  if (change === null || d.payments.length !== 1) {
    return (
      row('Paid Amount', d.paidAmount, d.currency) +
      row('Bal. Amount', d.balanceAmount, d.currency) +
      status +
      paymentRows
    );
  }

  // Exactly one payment, and it is the row that repeats the total, so it is
  // dropped: `Cash` above already says what was handed over.
  return (
    row('Paid Amount', d.amountTendered as number, d.currency) +
    row('Bal. Amount', change, d.currency) +
    status
  );
}

/** Two decimal places, away from binary-float noise (`0.1 + 0.2`). */
function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function money(amount: number, _currency: string): string {
  // Receipts always render in LKR (Rs.); the stored currency is kept for context.
  return esc(formatCurrency(amount));
}

const PRINT_BUTTON = `<button class="no-print print-btn" onclick="window.print()">Print</button>`;

/**
 * The date stamp printed on every receipt — sale and return alike.
 *
 * Rendered in the SHOP's timezone, matching the A4 invoice for the same
 * transaction, so a receipt and its invoice can never name different days and a
 * reprint always reads the same. The server's own zone is deliberately not used:
 * it is an accident of deployment, not a property of the business.
 */
export function formatReceiptDateTime(date: Date, tz: string): string {
  return formatDateTimeInTimeZone(date, tz);
}

export function renderCustomerReceipt(d: CustomerReceiptData): string {
  const rows = d.items
    .map(
      (it) => `
      <tr>
        <td>${esc(it.name)}${it.promotionNote ? `<br><span class="muted">${esc(it.promotionNote)}</span>` : ''}</td>
        <td class="r">${it.quantity}</td>
        <td class="r">${money(it.unitPrice, d.currency)}</td>
        <td class="r">${
          it.discountAmount > 0
            ? '-' +
              money(it.discountAmount, d.currency) +
              // "/u" rather than the invoice's "× 3": a 32-character roll has no
              // room for the long form, and the point is only that the amount is
              // per unit.
              (it.discountBasis === 'UNIT' && it.discountValue != null
                ? ` (${money(it.discountValue, d.currency)}/u)`
                : '')
            : '—'
        }</td>
        <td class="r">${money(it.lineTotal, d.currency)}</td>
      </tr>`,
    )
    .join('');

  // Labelled, not the raw enum — a customer receipt should not read "BANK_TRANSFER".
  // A remaining balance is listed as its own "Credit" line, so a credit sale says
  // how it was settled instead of printing no payment line at all; once the sale
  // is paid off, a reprint shows only the methods actually used.
  const payments = [
    ...d.payments.map((p) => ({ label: paymentMethodLabel(p.method), amount: p.amount })),
    ...(d.balanceAmount > 0
      ? [{ label: CREDIT_METHOD_LABEL, amount: d.balanceAmount }]
      : []),
  ]
    .map(
      (p) =>
        `<div class="row"><span>${esc(p.label)}</span><span>${money(p.amount, d.currency)}</span></div>`,
    )
    .join('');

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Receipt ${esc(d.saleNumber)}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: ui-monospace, "Courier New", monospace; color: #111; margin: 0; padding: 16px; }
  .receipt { max-width: 320px; margin: 0 auto; }
  h1 { font-size: 18px; text-align: center; margin: 0 0 2px; }
  .sub { text-align: center; color: #555; font-size: 12px; margin-bottom: 12px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { padding: 4px 2px; text-align: left; vertical-align: top; }
  th { border-bottom: 1px dashed #999; }
  .r { text-align: right; white-space: nowrap; }
  .muted { color: #777; font-size: 11px; }
  .totals { margin-top: 8px; border-top: 1px dashed #999; padding-top: 8px; font-size: 12px; }
  .row { display: flex; justify-content: space-between; padding: 2px 0; }
  .grand { font-weight: bold; font-size: 14px; border-top: 1px solid #333; margin-top: 4px; padding-top: 4px; }
  .foot { text-align: center; color: #555; font-size: 12px; margin-top: 14px; }
  .badge { text-align:center; font-size:11px; color:#555; margin-bottom:8px; }
  /* Loud on purpose. A void stamp that reads as a footnote has failed. */
  .void { text-align:center; font-weight:bold; font-size:20px; letter-spacing:6px;
          border:2px solid #111; padding:6px 0; margin:0 0 10px; }
  .void-note { text-align:center; font-size:11px; color:#555; margin:-6px 0 10px; }
  .print-btn { display:block; margin:0 auto 14px; padding:8px 16px; font-size:14px; cursor:pointer; }
  @media print { .no-print { display: none; } body { padding: 0; } }
</style></head>
<body>
  ${PRINT_BUTTON}
  <div class="receipt">
    <h1>${esc(d.storeName)}</h1>
    <div class="sub">Sales Receipt · ${esc(d.saleNumber)}<br>${esc(d.dateTime)}</div>
    ${d.voided ? '<div class="void">VOID</div><div class="void-note">This sale was voided. Not valid as proof of purchase.</div>' : ''}
    ${d.customerName ? `<div class="badge">Customer: ${esc(d.customerName)}</div>` : ''}
    ${d.documentType ? `<div class="badge">${esc(d.documentType)}</div>` : ''}
    <table>
      <thead><tr><th>Item</th><th class="r">Qty</th><th class="r">Price</th><th class="r">Disc</th><th class="r">Total</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="totals">
      <div class="row"><span>Subtotal</span><span>${money(d.subtotal, d.currency)}</span></div>
      ${d.totalDiscount - d.promotionDiscount > 0 ? `<div class="row"><span>Product discount</span><span>-${money(d.totalDiscount - d.promotionDiscount, d.currency)}</span></div>` : ''}
      ${d.promotionDiscount > 0 ? `<div class="row"><span>Promotions</span><span>-${money(d.promotionDiscount, d.currency)}</span></div>` : ''}
      ${d.orderDiscount > 0 ? `<div class="row"><span>Order discount</span><span>-${money(d.orderDiscount, d.currency)}</span></div>` : ''}
      ${(d.taxBreakdown ?? [])
        .map(
          (t) =>
            `<div class="row muted"><span>Tax @ ${esc(taxRateLabel(t.ratePercent))}</span><span>${money(t.taxAmount, d.currency)}</span></div>`,
        )
        .join('')}
      <div class="row"><span>Tax</span><span>${money(d.taxAmount, d.currency)}</span></div>
      <div class="row grand"><span>Bill Amount</span><span>${money(d.total, d.currency)}</span></div>
      ${settlementRows(d, payments)}
    </div>
    <div class="foot">${esc(d.footer)}</div>
  </div>
</body></html>`;
}
