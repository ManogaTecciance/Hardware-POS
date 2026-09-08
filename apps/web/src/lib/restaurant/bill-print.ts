import { getDocumentProfile } from '@/lib/document-template-service';
import { printReceipt } from '@/lib/receipt-print';
import { billing } from '@/lib/restaurant/api';
import { getActiveCurrency } from '@/lib/tenant-money';
import { renderThermalBill, type ThermalBillInput } from '@/lib/thermal-bill';
import type { Session } from '@/lib/auth';
import type { BillView } from '@/lib/restaurant/types';

/**
 * A closed bill, printed.
 *
 * ## Why this exists
 *
 * The map from a `BillView` to a `ThermalBillInput` was written twice —
 * byte-for-byte the same twenty lines in `bill-screen.tsx` and
 * `bill-dialog.tsx` — and D98 needed a third caller for the counter's
 * automatic receipt. A third copy is how a tenant ends up with the service
 * charge on one bill and not another; the template itself already carries that
 * warning, and this is the same argument one level up.
 *
 * ## Hiding the print dialog is not this module's to give
 *
 * `printReceipt` prints from a hidden iframe, so no window opens and none is
 * left behind (D78). The browser's PRINT DIALOG is a different thing: a page
 * cannot suppress it. Chrome shows it for every `window.print()` unless the
 * browser itself was started with `--kiosk-printing`, which makes it print to
 * the default printer with no prompt. That is a property of the till's browser,
 * not of this code — see D98.
 */

export interface BillPrintContext {
  /** Falls back to the branch name when the document profile has no company name. */
  fallbackName: string;
  /** D87 — who is handing the paper over, resolved now, not who closed the table. */
  cashierName: string | null;
  /** Marks a duplicate so a reprint cannot pass as the original. */
  copyLabel?: string | null;
}

/**
 * The single map from a bill to the thing that gets printed.
 *
 * Pure, so a test can assert the whole shape without a browser, a network or a
 * printer — which is what the three call sites could never do while each held
 * its own copy.
 */
export function billToThermalInput(
  view: BillView,
  profile: Parameters<typeof renderThermalBill>[0]['profile'],
  ctx: BillPrintContext,
): ThermalBillInput {
  return {
    profile,
    fallbackName: ctx.fallbackName,
    currency: getActiveCurrency(),
    documentNumber: view.saleNumber,
    placeLabel: view.placeLabel,
    servedBy: view.servedByName,
    cashierName: ctx.cashierName,
    copyLabel: ctx.copyLabel ?? null,
    issuedAt: new Date(view.closedAt),
    lines: view.items.map((it) => ({
      name: it.name,
      variantName: it.variantName,
      quantity: it.quantity,
      lineTotal: it.lineTotal,
      specialInstructions: it.specialInstructions,
    })),
    subtotal: view.subtotal,
    discount: view.totalDiscount,
    serviceCharge: view.serviceChargeAmount,
    packaging: view.packagingCharge,
    tax: view.taxAmount,
    total: view.total,
    paid: view.paidAmount,
    balance: view.balanceAmount,
    payments: view.payments.map((p) => ({ method: p.method, amount: p.amount })),
    note: profile.billNote || null,
  };
}

/** Fetch the document profile, render this bill, and send it to the printer. */
export async function printBillView(
  session: Session,
  view: BillView,
  ctx: Omit<BillPrintContext, 'fallbackName'> & { fallbackName?: string },
): Promise<void> {
  const profile = await getDocumentProfile(session);
  printReceipt(
    renderThermalBill(
      billToThermalInput(view, profile, {
        fallbackName: ctx.fallbackName ?? session.branchName ?? '',
        cashierName: ctx.cashierName,
        copyLabel: ctx.copyLabel,
      }),
    ),
  );
}

/**
 * Print the receipt for a sale we only have the id of.
 *
 * D98 — the counter's automatic receipt. It fetches the bill rather than
 * printing from the cart, because the SERVER is what decided the totals: the
 * service charge, the tax and any rounding are applied when the sale is
 * created, and a receipt rendered from the operator's basket can disagree with
 * the money that was actually taken.
 */
export async function printSaleReceipt(
  session: Session,
  saleId: string,
  ctx: Omit<BillPrintContext, 'fallbackName'> & { fallbackName?: string },
): Promise<void> {
  const view = await billing.get(session, saleId);
  await printBillView(session, view, ctx);
}
