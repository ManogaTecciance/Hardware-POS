/**
 * Printable return / refund receipt. Same thermal-receipt look as the sales
 * receipt (`receipts/receipt-templates.ts`) with a REFUND banner and refund
 * breakdown. Standalone HTML with inline print CSS and a screen-only Print
 * button. Always renders in LKR (Rs.).
 */
import { formatCurrency } from '@hardware-pos/shared';

export interface ReturnReceiptLine {
  name: string;
  sku: string | null;
  quantity: number;
  unitPrice: number;
  discountAdjustment: number;
  refundableAmount: number;
  reason: string;
  condition: string;
}

export interface ReturnReceiptData {
  storeName: string;
  /**
   * D174 — the shop's logo, already inlined as a `data:` URI.
   *
   * D172 put this on the sales receipt and the A4 letterhead and missed the
   * return, which is the one a customer is handed while they are unhappy. Same
   * field, same contract: a `data:` URI and not a path, because this HTML is
   * printed from a hidden iframe in the web app where `/uploads/<key>` would
   * resolve against the web app and 404.
   *
   * Optional, and absent means no logo — the receipt then prints exactly what
   * it printed before, which is what every tenant without one gets.
   */
  logoDataUri?: string | null;
  branchName: string | null;
  registerName: string | null;
  returnNumber: string;
  originalSaleNumber: string;
  dateTime: string;
  documentType: string;
  customerName: string | null;
  cashierName: string | null;
  approverName: string | null;
  items: ReturnReceiptLine[];
  subtotal: number;
  productDiscountAdjustment: number;
  orderDiscountAdjustment: number;
  taxAdjustment: number;
  refundTotal: number;
  refundMethod: string;
  refundReference: string | null;
  remainingSaleValue: number;
  syncStatus: string | null;
  footer: string;
}

function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function money(amount: number): string {
  // Return receipts always render in LKR (Rs.).
  return esc(formatCurrency(amount));
}

const PRINT_BUTTON = `<button class="no-print print-btn" onclick="window.print()">Print</button>`;

/**
 * D174 — the logo above the shop name, when there is one.
 *
 * The NAME is never replaced by the logo, for the reason D172 gives: a roll is
 * 80mm and monochrome, and a logo that prints as a grey smear on a refund slip
 * carrying no shop name is worse than no logo. On THIS receipt it matters more
 * than on the sales one — a refund slip is the document a customer keeps to
 * prove the shop took the goods back.
 */
function logoBlock(d: ReturnReceiptData): string {
  if (!d.logoDataUri) return '';
  return `<div class="logo"><img src="${esc(d.logoDataUri)}" alt="${esc(d.storeName)}" /></div>`;
}

export function renderReturnReceipt(d: ReturnReceiptData): string {
  const rows = d.items
    .map(
      (it) => `
      <tr>
        <td>${esc(it.name)}${it.sku ? `<br><span class="muted">${esc(it.sku)}</span>` : ''}<br><span class="muted">${esc(it.reason)} · ${esc(it.condition)}</span></td>
        <td class="r">${it.quantity}</td>
        <td class="r">${money(it.unitPrice)}</td>
        <td class="r">-${money(it.refundableAmount)}</td>
      </tr>`,
    )
    .join('');

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Return ${esc(d.returnNumber)}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: ui-monospace, "Courier New", monospace; color: #111; margin: 0; padding: 16px; }
  .receipt { max-width: 320px; margin: 0 auto; }
  /* D174 — sized in mm because the output is paper, not a screen. */
  .logo { text-align: center; margin-bottom: 6px; }
  .logo img { max-height: 18mm; max-width: 100%; object-fit: contain; }
  h1 { font-size: 18px; text-align: center; margin: 0 0 2px; }
  .sub { text-align: center; color: #555; font-size: 12px; margin-bottom: 8px; }
  .refund-banner { text-align:center; font-weight:bold; letter-spacing:1px; border:1px solid #333; padding:4px; margin-bottom:10px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { padding: 4px 2px; text-align: left; vertical-align: top; }
  th { border-bottom: 1px dashed #999; }
  .r { text-align: right; white-space: nowrap; }
  .muted { color: #777; font-size: 11px; }
  .totals { margin-top: 8px; border-top: 1px dashed #999; padding-top: 8px; font-size: 12px; }
  .row { display: flex; justify-content: space-between; padding: 2px 0; }
  .grand { font-weight: bold; font-size: 14px; border-top: 1px solid #333; margin-top: 4px; padding-top: 4px; }
  .foot { text-align: center; color: #555; font-size: 12px; margin-top: 14px; }
  .badge { text-align:center; font-size:11px; color:#555; margin-bottom:4px; }
  .print-btn { display:block; margin:0 auto 14px; padding:8px 16px; font-size:14px; cursor:pointer; }
  @media print { .no-print { display: none; } body { padding: 0; } }
</style></head>
<body>
  ${PRINT_BUTTON}
  <div class="receipt">
    ${logoBlock(d)}
    <h1>${esc(d.storeName)}</h1>
    <div class="sub">${d.branchName ? esc(d.branchName) : ''}${d.registerName ? ` · ${esc(d.registerName)}` : ''}</div>
    <div class="refund-banner">RETURN / REFUND</div>
    <div class="sub">Return ${esc(d.returnNumber)}<br>Original sale ${esc(d.originalSaleNumber)}<br>${esc(d.dateTime)}</div>
    <div class="badge">${esc(d.documentType)}</div>
    ${d.customerName ? `<div class="badge">Customer: ${esc(d.customerName)}</div>` : ''}
    ${d.cashierName ? `<div class="badge">Cashier: ${esc(d.cashierName)}</div>` : ''}
    ${d.approverName ? `<div class="badge">Approved by: ${esc(d.approverName)}</div>` : ''}
    <table>
      <thead><tr><th>Item</th><th class="r">Qty</th><th class="r">Price</th><th class="r">Refund</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="totals">
      <div class="row"><span>Returned subtotal</span><span>${money(d.subtotal)}</span></div>
      <div class="row"><span>Product discount adj.</span><span>-${money(d.productDiscountAdjustment)}</span></div>
      ${d.orderDiscountAdjustment > 0 ? `<div class="row"><span>Order discount adj.</span><span>-${money(d.orderDiscountAdjustment)}</span></div>` : ''}
      <div class="row"><span>Tax adjustment</span><span>${money(d.taxAdjustment)}</span></div>
      <div class="row grand"><span>Refund total</span><span>${money(d.refundTotal)}</span></div>
      <div class="row"><span>Refund method</span><span>${esc(d.refundMethod)}</span></div>
      ${d.refundReference ? `<div class="row"><span>Reference</span><span>${esc(d.refundReference)}</span></div>` : ''}
      <div class="row"><span>Remaining sale value</span><span>${money(d.remainingSaleValue)}</span></div>
      ${d.syncStatus ? `<div class="row"><span>QuickBooks</span><span>${esc(d.syncStatus)}</span></div>` : ''}
    </div>
    <div class="foot">${esc(d.footer)}</div>
  </div>
</body></html>`;
}
