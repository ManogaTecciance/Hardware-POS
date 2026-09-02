/**
 * Printable HTML templates. Each returns a complete standalone document with
 * inline print CSS and a screen-only Print button (browser print for v1).
 */
import { formatCurrency } from '@hardware-pos/shared';
import { taxRateLabel } from '@hardware-pos/shared';

export interface ReceiptLine {
  name: string;
  sku: string | null;
  quantity: number;
  unitPrice: number;
  discountAmount: number;
  lineTotal: number;
}

export interface CustomerReceiptData {
  storeName: string;
  saleNumber: string;
  dateTime: string;
  documentType: string | null;
  customerName: string | null;
  currency: string;
  items: ReceiptLine[];
  subtotal: number;
  totalDiscount: number;
  orderDiscount: number;
  taxAmount: number;
  /**
   * D101 (3.12) — per-rate rows, or empty when the document should print
   * exactly what it printed before: a single-rate sale, a restaurant Sale (no
   * lines) or a sale predating 3.8.
   */
  taxBreakdown?: { ratePercent: number; taxAmount: number }[];
  total: number;
  paidAmount: number;
  balanceAmount: number;
  paymentStatus: string;
  payments: { method: string; amount: number }[];
  footer: string;
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

export function renderCustomerReceipt(d: CustomerReceiptData): string {
  const rows = d.items
    .map(
      (it) => `
      <tr>
        <td>${esc(it.name)}${it.sku ? `<br><span class="muted">${esc(it.sku)}</span>` : ''}</td>
        <td class="r">${it.quantity}</td>
        <td class="r">${money(it.unitPrice, d.currency)}</td>
        <td class="r">${it.discountAmount > 0 ? '-' + money(it.discountAmount, d.currency) : '—'}</td>
        <td class="r">${money(it.lineTotal, d.currency)}</td>
      </tr>`,
    )
    .join('');

  const payments = d.payments
    .map((p) => `<div class="row"><span>${esc(p.method)}</span><span>${money(p.amount, d.currency)}</span></div>`)
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
  .print-btn { display:block; margin:0 auto 14px; padding:8px 16px; font-size:14px; cursor:pointer; }
  @media print { .no-print { display: none; } body { padding: 0; } }
</style></head>
<body>
  ${PRINT_BUTTON}
  <div class="receipt">
    <h1>${esc(d.storeName)}</h1>
    <div class="sub">Sales Receipt · ${esc(d.saleNumber)}<br>${esc(d.dateTime)}</div>
    ${d.customerName ? `<div class="badge">Customer: ${esc(d.customerName)}</div>` : ''}
    ${d.documentType ? `<div class="badge">${esc(d.documentType)}</div>` : ''}
    <table>
      <thead><tr><th>Item</th><th class="r">Qty</th><th class="r">Price</th><th class="r">Disc</th><th class="r">Total</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="totals">
      <div class="row"><span>Subtotal</span><span>${money(d.subtotal, d.currency)}</span></div>
      <div class="row"><span>Product discount</span><span>-${money(d.totalDiscount, d.currency)}</span></div>
      ${d.orderDiscount > 0 ? `<div class="row"><span>Order discount</span><span>-${money(d.orderDiscount, d.currency)}</span></div>` : ''}
      ${(d.taxBreakdown ?? [])
        .map(
          (t) =>
            `<div class="row muted"><span>Tax @ ${esc(taxRateLabel(t.ratePercent))}</span><span>${money(t.taxAmount, d.currency)}</span></div>`,
        )
        .join('')}
      <div class="row"><span>Tax</span><span>${money(d.taxAmount, d.currency)}</span></div>
      <div class="row grand"><span>Total</span><span>${money(d.total, d.currency)}</span></div>
      <div class="row"><span>Paid</span><span>${money(d.paidAmount, d.currency)}</span></div>
      <div class="row"><span>Balance</span><span>${money(d.balanceAmount, d.currency)}</span></div>
      <div class="row"><span>Status</span><span>${esc(d.paymentStatus)}</span></div>
      ${payments}
    </div>
    <div class="foot">${esc(d.footer)}</div>
  </div>
</body></html>`;
}
