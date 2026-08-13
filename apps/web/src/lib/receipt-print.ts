import { api } from './api';
import type { Session } from './auth';
import type { CartItem } from './cart';
import { computeLine } from './cart';
import type { CompletedSale } from './sales';
import { formatMoney } from './utils';

export interface ReceiptContext {
  currency: string;
  customerName: string;
  items: CartItem[];
  subtotal: number;
  totalDiscount: number;
  orderDiscount: number;
  taxAmount: number;
  storeName?: string;
}

function esc(v: unknown): string {
  return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Minimal printable receipt used as a fallback when the server render fails. */
function clientReceiptHtml(sale: CompletedSale, ctx: ReceiptContext): string {
  const rows = ctx.items
    .map((it) => {
      const line = computeLine(it);
      return `<tr><td>${esc(it.product.name)}<br><span class="m">${it.quantity} × ${formatMoney(it.product.unitPrice, ctx.currency)}</span></td><td class="r">${formatMoney(line.lineTotal, ctx.currency)}</td></tr>`;
    })
    .join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Receipt ${esc(sale.saleNumber)}</title>
<style>body{font-family:ui-monospace,monospace;max-width:320px;margin:0 auto;padding:16px;color:#111}
h1{font-size:16px;text-align:center;margin:0}.sub{text-align:center;color:#666;font-size:12px;margin-bottom:10px}
table{width:100%;border-collapse:collapse;font-size:12px}td{padding:3px 0;vertical-align:top}.r{text-align:right;white-space:nowrap}
.m{color:#777;font-size:11px}.tot{border-top:1px dashed #999;margin-top:8px;padding-top:8px;font-size:12px}
.row{display:flex;justify-content:space-between;padding:1px 0}.g{font-weight:bold;font-size:14px;border-top:1px solid #333;margin-top:3px;padding-top:3px}
.btn{display:block;margin:0 auto 12px;padding:8px 16px;cursor:pointer}@media print{.btn{display:none}body{padding:0}}</style></head>
<body><button class="btn" onclick="window.print()">Print</button>
<h1>${esc(ctx.storeName ?? 'Hardware POS')}</h1>
<div class="sub">Sales Receipt · ${esc(sale.saleNumber)}<br>Customer: ${esc(ctx.customerName)}</div>
<table>${rows}</table>
<div class="tot">
<div class="row"><span>Subtotal</span><span>${formatMoney(ctx.subtotal, ctx.currency)}</span></div>
<div class="row"><span>Product discount</span><span>-${formatMoney(ctx.totalDiscount, ctx.currency)}</span></div>
${ctx.orderDiscount > 0 ? `<div class="row"><span>Order discount</span><span>-${formatMoney(ctx.orderDiscount, ctx.currency)}</span></div>` : ''}
<div class="row"><span>Tax</span><span>${formatMoney(ctx.taxAmount, ctx.currency)}</span></div>
<div class="row g"><span>Total</span><span>${formatMoney(sale.total, ctx.currency)}</span></div>
<div class="row"><span>Paid</span><span>${formatMoney(sale.paidAmount, ctx.currency)}</span></div>
<div class="row"><span>Balance</span><span>${formatMoney(sale.balanceAmount, ctx.currency)}</span></div>
</div></body></html>`;
}

let printTimer: number | null = null;

export function openPrintWindow(html: string): void {
  // One *named* popup, reused across prints: repeated clicks replace the
  // receipt in place instead of stacking new windows and print dialogs
  // (which eventually hangs the tab).
  const win = window.open('', 'hpos-receipt-print', 'width=420,height=680');
  if (!win) return;
  if (printTimer != null) window.clearTimeout(printTimer);
  win.document.open();
  win.document.write(html);
  win.document.close();
  win.focus();
  printTimer = window.setTimeout(() => {
    printTimer = null;
    win.print();
  }, 400);
}

/** Print the customer receipt: server-rendered, with a client-side fallback. */
export async function printCustomerReceipt(
  session: Session,
  sale: CompletedSale,
  ctx: ReceiptContext,
): Promise<void> {
  try {
    const res = await api.post<{ printJob: { html: string } }>(
      `/receipts/${sale.id}/customer`,
      undefined,
      { token: session.token, tenantId: session.user.tenantId },
    );
    openPrintWindow(res.printJob.html);
    return;
  } catch {
    // fall through to the client-rendered receipt
  }
  openPrintWindow(clientReceiptHtml(sale, ctx));
}

let reprintInFlight = false;

/** Reprint a persisted sale's customer receipt from the Sales section. */
export async function reprintCustomerReceipt(session: Session, saleId: string): Promise<void> {
  // Drop clicks that land before the previous reprint finished — the button's
  // disabled state only takes effect after the next React render.
  if (reprintInFlight) return;
  reprintInFlight = true;
  try {
    const res = await api.post<{ printJob: { html: string } }>(
      `/receipts/${saleId}/customer`,
      undefined,
      { token: session.token, tenantId: session.user.tenantId },
    );
    openPrintWindow(res.printJob.html);
  } finally {
    reprintInFlight = false;
  }
}


/**
 * D51 — a printable bill for ONE split: the lines that party ate and what
 * they owe. Reuses the shared named print window so repeated prints replace
 * each other instead of stacking dialogs.
 */
export function printSplitBill(input: {
  storeName: string;
  saleNumber: string;
  splitLabel: string;
  items: Array<{ name: string; quantity: string; lineTotal: string }>;
  share: string;
  paidAmount: string;
}): void {
  const rows = input.items
    .map(
      (it) =>
        `<tr><td>${esc(it.name)}<br><span class="m">× ${esc(trimQty(it.quantity))}</span></td><td class="r">${esc(it.lineTotal)}</td></tr>`,
    )
    .join('');
  const balance = (Number(input.share) - Number(input.paidAmount)).toFixed(2);
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Bill ${esc(input.saleNumber)} — ${esc(input.splitLabel)}</title>
<style>body{font-family:ui-monospace,monospace;max-width:320px;margin:0 auto;padding:16px;color:#111}
h1{font-size:16px;text-align:center;margin:0}.sub{text-align:center;color:#666;font-size:12px;margin-bottom:10px}
table{width:100%;border-collapse:collapse;font-size:12px}td{padding:3px 0;vertical-align:top}.r{text-align:right;white-space:nowrap}
.m{color:#777;font-size:11px}.tot{border-top:1px dashed #999;margin-top:8px;padding-top:8px;font-size:12px}
.row{display:flex;justify-content:space-between;padding:1px 0}.g{font-weight:bold;font-size:14px;border-top:1px solid #333;margin-top:3px;padding-top:3px}
.btn{display:block;margin:0 auto 12px;padding:8px 16px;cursor:pointer}@media print{.btn{display:none}body{padding:0}}</style></head>
<body><button class="btn" onclick="window.print()">Print</button>
<h1>${esc(input.storeName)}</h1>
<div class="sub">Split bill · ${esc(input.saleNumber)}<br>${esc(input.splitLabel)}</div>
<table>${rows}</table>
<div class="tot">
<div class="row g"><span>Total</span><span>${esc(input.share)}</span></div>
<div class="row"><span>Paid</span><span>${esc(input.paidAmount)}</span></div>
<div class="row"><span>Balance</span><span>${esc(balance)}</span></div>
</div></body></html>`;
  openPrintWindow(html);
}

/** "2.000" reads badly on a bill; "2" and "0.5" do. */
function trimQty(q: string): string {
  return String(Number(q));
}
