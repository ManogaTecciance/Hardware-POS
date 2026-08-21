import { api } from './api';
import { RECEIPT_WIDTH_MM, renderThermalBill, type ThermalBillInput } from './thermal-bill';
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
export interface PendingPrintWindow {
  render: (html: string) => void;
  abort: () => void;
}

export interface BeginPrintOptions {
  /**
   * Size the page to the receipt: one page, ending where the text ends.
   *
   * On by default for the callers that pass a roll width. Turn it OFF for a
   * printer whose driver has a FIXED page length — Chrome scales a page it
   * cannot match onto the paper it has, and a long bill then prints
   * correct-but-tiny rather than long.
   */
  fitToContent?: boolean;
  /** Roll width in millimetres. 80 is the common thermal default; 58 exists. */
  paperWidthMm?: number;
}

export function beginPrintWindow(options: BeginPrintOptions = {}): PendingPrintWindow {
  const win = window.open('', 'hpos-receipt-print', 'width=420,height=680');
  if (!win) return { render: () => {}, abort: () => {} };
  // Something honest on screen while the profile resolves — a blank popup
  // reads as a crash.
  win.document.open();
  win.document.write('<!doctype html><title>Preparing bill…</title>');
  win.document.close();
  return {
    render: (html) =>
      fillAndPrint(
        win,
        html,
        options.fitToContent === false
          ? undefined
          : { widthMm: options.paperWidthMm ?? RECEIPT_WIDTH_MM },
      ),
    abort: () => win.close(),
  };
}

export function openPrintWindow(html: string, fit?: { widthMm: number }): void {
  // One *named* popup, reused across prints: repeated clicks replace the
  // receipt in place instead of stacking new windows and print dialogs
  // (which eventually hangs the tab).
  const win = window.open('', 'hpos-receipt-print', 'width=420,height=680');
  if (!win) return;
  fillAndPrint(win, html, fit);
}

/**
 * D75 — make the printed page exactly as tall as the receipt.
 *
 * Two things the PO asked for turn out to be one mechanism. A bill that
 * spans pages prints a band of blank paper at each boundary, and a bill that
 * ends a third of the way down its last page feeds the remaining two thirds
 * before it can be torn off. With ONE page, sized to the content, there is
 * no boundary to leak a gap and no remainder to feed: the receipt ends where
 * the text ends.
 *
 * ## Why this was reverted once, and what is different
 *
 * An earlier attempt shrank long bills. `@page { size }` is a REQUEST: when
 * the size does not match the paper the driver reports, Chrome scales the
 * page to fit — 432 mm of receipt squeezed onto a 297 mm sheet is 69%, which
 * is exactly the unreadable print that came back. That is a printer-side
 * setting (a roll/variable paper length, and Scale at 100%), not something
 * CSS can assert.
 *
 * So this is now a per-call opt-in with an escape hatch, rather than
 * something every receipt does silently: a workspace whose driver has a
 * fixed page length turns it off and gets correct-size print across
 * multiple pages instead.
 *
 * `size: 80mm auto` would be the obvious thing to write and is invalid CSS —
 * the property takes one or two lengths — so the height is measured. Done
 * LAST, after images settle: a logo that has not decoded reports no height
 * and would truncate the receipt to the height of its text.
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

/** Write the document, wait for it to be printable, print it, close up. */
function fillAndPrint(win: Window, html: string, fit?: { widthMm: number }): void {
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
  /*
   * D74 — close the popup once the print has been dispatched.
   *
   * `afterprint` fires when the browser is finished with the document,
   * whether the operator printed or dismissed the dialog. There is no web
   * API that distinguishes the two, so both close the window: a cashier who
   * cancels wanted out of it either way, and the alternative — leaving a
   * dead receipt tab open behind the POS — is what this is fixing.
   *
   * Attached BEFORE `print()`, because in some browsers `print()` is
   * synchronous and `afterprint` has already fired by the time it returns.
   */
  win.addEventListener('afterprint', () => win.close(), { once: true });

  void Promise.race([
    Promise.all(settled),
    new Promise((resolve) => window.setTimeout(resolve, 4000)),
  ]).then(() => {
    if (fit) fitPageToContent(win, fit.widthMm);
    printTimer = window.setTimeout(() => {
      printTimer = null;
      /*
       * The print dialog opens by itself — no click on the page. Whether the
       * OPERATING SYSTEM's dialog then needs a confirming click is not
       * something a web page can decide: only Chrome's `--kiosk-printing`
       * launch flag makes `print()` go straight to the default printer, and
       * a page cannot set it. On a till launched with that flag this call is
       * already the whole interaction; without it the dialog is the browser's
       * to own. See docs/restaurant-pos/00-decisions.md, D74.
       */
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
export function printTableBill(
  input: Omit<ThermalBillInput, 'profile'> & {
    profile?: DocumentProfile;
  },
): void {
  openPrintWindow(
    renderThermalBill({ ...input, profile: input.profile ?? getCachedDocumentProfile() }),
    { widthMm: RECEIPT_WIDTH_MM },
  );
}

/**
 * D51 — a printable bill for ONE split: the lines that party ate and what
 * they owe. D72 routes it through the shared thermal template so a split
 * bill and a whole bill are the same document with different lines.
 */
export function printSplitBill(input: SplitBillInput): void {
  openPrintWindow(renderSplitBill(input), { widthMm: RECEIPT_WIDTH_MM });
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
