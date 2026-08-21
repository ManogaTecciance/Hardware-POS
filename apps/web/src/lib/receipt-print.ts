import { api } from './api';
import { renderThermalBill, type ThermalBillInput } from './thermal-bill';
import type { Session } from './auth';
import type { CartItem } from './cart';
import { computeLine } from './cart';
import type { CompletedSale } from './sales';
import { getCachedDocumentProfile, type DocumentProfile } from './document-template-service';
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
<h1>${esc(ctx.storeName ?? getCachedDocumentProfile().companyName ?? '')}</h1>
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

  /*
   * D72 — wait for images before printing. A bill now carries the tenant's
   * logo, and `print()` captures the document as it stands: fire it while
   * the image is still decoding and the logo prints as a blank box. Every
   * image is awaited (load OR error — a broken logo must not hold the
   * dialog hostage), then a short beat for layout to settle.
   *
   * The 4s ceiling is the backstop: a data: URI resolves instantly and a
   * remote one usually does, but an unreachable host would otherwise mean
   * a print dialog that never opens, which reads as "the button is broken".
   */
  const images = Array.from(win.document.images);
  const settled = images.map(
    (img) =>
      img.complete ||
      new Promise<void>((resolve) => {
        img.addEventListener('load', () => resolve(), { once: true });
        img.addEventListener('error', () => resolve(), { once: true });
      }),
  );
  void Promise.race([
    Promise.all(settled),
    new Promise((resolve) => window.setTimeout(resolve, 4000)),
  ]).then(() => {
    printTimer = window.setTimeout(() => {
      printTimer = null;
      win.print();
    }, 150);
  });
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
 * D69/D72 — the whole table bill, printed by the cashier.
 *
 * Rendered CLIENT-side, deliberately: `/receipts/:saleId/customer` sits
 * behind `@RequireModule(RETAIL_POS)` and answers 403 to every food-service
 * workspace, owner included.
 *
 * D72 replaced the ad-hoc markup with `renderThermalBill`, so this and the
 * split bill below print the SAME document — same header, same columns, same
 * totals block. Two hand-written receipt templates is how a tenant ends up
 * with a logo on one bill and not the other.
 */
export function printTableBill(input: Omit<ThermalBillInput, 'profile'> & {
  profile?: DocumentProfile;
}): void {
  openPrintWindow(
    renderThermalBill({ ...input, profile: input.profile ?? getCachedDocumentProfile() }),
  );
}

/**
 * D51 — a printable bill for ONE split: the lines that party ate and what
 * they owe. D72 routes it through the shared thermal template so a split
 * bill and a whole bill are the same document with different lines.
 */
export function printSplitBill(input: {
  storeName: string;
  currency?: string;
  saleNumber: string;
  splitLabel: string;
  items: Array<{ name: string; quantity: string; lineTotal: string }>;
  share: string;
  paidAmount: string;
  profile?: DocumentProfile;
  servedBy?: string | null;
  placeLabel?: string | null;
  issuedAt?: Date;
}): void {
  const balance = (Number(input.share) - Number(input.paidAmount)).toFixed(2);
  openPrintWindow(
    renderThermalBill({
      profile: input.profile ?? getCachedDocumentProfile(),
      fallbackName: input.storeName,
      currency: input.currency,
      documentNumber: input.saleNumber,
      placeLabel: input.placeLabel ?? null,
      servedBy: input.servedBy ?? null,
      // Whose bill this is — the one thing that distinguishes four bills
      // printed off one table within a minute of each other.
      copyLabel: input.splitLabel,
      issuedAt: input.issuedAt ?? new Date(),
      lines: input.items.map((it) => ({
        name: it.name,
        quantity: it.quantity,
        lineTotal: it.lineTotal,
      })),
      // A split's share IS its total: the server has already apportioned the
      // service charge and every other bill-level amount into it, so listing
      // those again here would double-count them on the paper.
      subtotal: input.share,
      total: input.share,
      paid: input.paidAmount,
      balance,
    }),
  );
}

/**
 * D54 — the split bill printed bare decimals with no currency at all, the one
 * customer-facing document in the app without a unit.
 */
function money(value: string, currency?: string): string {
  return formatMoney(Number(value), currency);
}

/** "2.000" reads badly on a bill; "2" and "0.5" do. */
function trimQty(q: string): string {
  return String(Number(q));
}
