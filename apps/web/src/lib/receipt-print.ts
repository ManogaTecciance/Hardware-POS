import { api } from './api';
import {
  RECEIPT_WIDTH_MM,
  RECEIPT_WIDTH_PX,
  renderThermalBill,
  type ThermalBillInput,
} from './thermal-bill';
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
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
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

/**
 * A print window opened NOW, filled in later.
 *
 * D74 — the popup must be opened in the click's own turn. Browsers grant a
 * gesture a few seconds of "transient activation" and `window.open` after an
 * `await` gambles on that not having lapsed: the bill screen fetches the
 * document profile first, so on a slow connection the popup is simply
 * blocked and the operator sees nothing happen at all.
 *
 * `abort()` exists because a window opened up front must not be left blank
 * and orphaned when the data it was opened for fails to arrive.
 */
/**
 * D78 — print a receipt from a hidden IFRAME, not a popup window.
 *
 * Three rounds were spent trying to make a popup close itself: the opener
 * cannot reliably close it (Chrome ignores `close()` while the preview is
 * up, and does not deliver `afterprint` to a listener the opener
 * registered), and a script inside the document did not do it either.
 *
 * An iframe removes the problem rather than patching it. There is no window
 * to close: the print dialog opens over the app, and when it is dismissed
 * the operator is already back where they were. Cleanup is a detached DOM
 * node — if it were ever delayed, nobody would see anything, which is the
 * opposite of a receipt window left standing open.
 *
 * It also drops the popup blocker from the picture entirely, so the document
 * profile can be fetched before printing without racing a user gesture.
 */
export function printReceipt(
  html: string,
  options: { fitToContent?: boolean; paperWidthMm?: number } = {},
): void {
  const widthMm = options.paperWidthMm ?? RECEIPT_WIDTH_MM;
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.title = 'Receipt';
  /*
   * Off-screen rather than zero-sized: the document has to LAY OUT at the
   * receipt's true width, because the page height is measured from it. A
   * 0×0 frame lays out at zero width, wraps every line, and would report a
   * height that has nothing to do with the printed bill.
   */
  frame.style.cssText = `position:fixed;left:-10000px;top:0;width:${RECEIPT_WIDTH_PX}px;height:0;border:0;visibility:hidden`;
  document.body.appendChild(frame);

  const win = frame.contentWindow;
  const doc = frame.contentDocument ?? win?.document;
  if (!win || !doc) {
    frame.remove();
    return;
  }
  doc.open();
  doc.write(html);
  doc.close();

  const cleanup = () => frame.remove();

  void whenImagesSettle(doc).then(() => {
    if (options.fitToContent !== false) fitPageToContent(win, widthMm);
    // A beat for the injected @page rule and final layout to take effect.
    window.setTimeout(() => {
      win.focus();
      win.print();
      /*
       * Removed on `afterprint` where the browser sends it, and on a timer
       * regardless. The frame is invisible, so a late removal costs nothing
       * — and removing it too early would tear the document out from under
       * a dialog that is still open.
       */
      win.addEventListener('afterprint', cleanup, { once: true });
      window.setTimeout(cleanup, 60_000);
    }, 120);
  });
}

/**
 * D75/D79 — make the printed page exactly as tall as the receipt.
 *
 * Only for thermal bills, and only useful once the driver can honour it: the
 * PO's Xprinter had a Maximum Length of 101.6 mm, so every page-sized request
 * beyond that was refused and the receipt split. Raising that length in the
 * driver is what made this work.
 *
 * `size: 78mm auto` would be the obvious thing to write and is invalid CSS —
 * the property takes one or two lengths — so the height is measured. After
 * images settle: a logo that has not decoded reports no height and would
 * truncate the receipt to the height of its text. Plus 2 mm so the cutter
 * does not shave the footer.
 */
function fitPageToContent(win: Window, widthMm: number): void {
  const doc = win.document;
  const heightPx = Math.max(doc.body.scrollHeight, doc.documentElement.scrollHeight);
  if (heightPx <= 0) return; // nothing laid out — leave the default sheet alone
  // 96 CSS px = 1 inch = 25.4 mm. Plus 2mm so the cutter does not shave the
  // last line; a receipt cut flush against its footer looks torn.
  const heightMm = Math.ceil((heightPx / 96) * 25.4) + 2;
  const style = doc.createElement('style');
  style.dataset.role = 'page-size';
  style.textContent = `@page{size:${widthMm}mm ${heightMm}mm;margin:0}`;
  doc.head.appendChild(style);
}

/**
 * Resolve once every image has loaded or failed, with a ceiling.
 *
 * `print()` captures the document as it stands: fire it while the tenant's
 * logo is still decoding and the logo prints as a blank box. `error` counts
 * as settled — a broken image must not hold the dialog hostage — and the
 * 4 s ceiling means an unreachable host cannot mean a dialog that never
 * opens, which reads as "the button is broken".
 */
function whenImagesSettle(doc: Document): Promise<unknown> {
  const pending = Array.from(doc.images)
    .filter((img) => !img.complete)
    .map(
      (img) =>
        new Promise<void>((resolve) => {
          img.addEventListener('load', () => resolve(), { once: true });
          img.addEventListener('error', () => resolve(), { once: true });
        }),
    );
  return Promise.race([
    Promise.all(pending),
    new Promise((resolve) => window.setTimeout(resolve, 4000)),
  ]);
}

/**
 * D79 — kept for the callers that still say "open a print window", but there
 * is no window: it delegates to the iframe.
 *
 * Every popup-based path had the same defect — a receipt window the operator
 * had to close by hand — and fixing it per call site would have left the next
 * one to rediscover it. The page SIZE is not touched here: a retail receipt
 * prints to whatever sheet the till is set up with (D16), and only the
 * thermal bill asks to be sized to its content.
 */
export function openPrintWindow(html: string): void {
  printReceipt(html, { fitToContent: false });
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
export function printTableBill(
  input: Omit<ThermalBillInput, 'profile'> & {
    profile?: DocumentProfile;
  },
): void {
  printReceipt(
    renderThermalBill({ ...input, profile: input.profile ?? getCachedDocumentProfile() }),
  );
}

/**
 * D51 — a printable bill for ONE split: the lines that party ate and what
 * they owe. D72 routes it through the shared thermal template so a split
 * bill and a whole bill are the same document with different lines.
 */
export function printSplitBill(input: SplitBillInput): void {
  printReceipt(renderSplitBill(input));
}

export interface SplitBillInput {
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
}

/**
 * D74 — composing the split bill is separate from printing it, so a caller
 * that must open its popup inside the click (before the profile has been
 * fetched) can render into a window it already holds.
 */
export function renderSplitBill(input: SplitBillInput): string {
  const balance = (Number(input.share) - Number(input.paidAmount)).toFixed(2);
  return renderThermalBill({
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
  });
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
