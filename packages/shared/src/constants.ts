/**
 * Application-wide constants shared across web and API.
 */

/** Current API version prefix, e.g. used as `/${API_VERSION}/...`. */
export const API_VERSION = 'v1';

/**
 * Centralized currency configuration. The POS operates in Sri Lankan Rupees;
 * QuickBooks Online remains the accounting master (its company currency should
 * match — see the sync warning in the QuickBooks screens).
 */
export const CURRENCY_CODE = 'LKR';
export const CURRENCY_SYMBOL = 'Rs.';
export const CURRENCY_LOCALE = 'en-LK';

/** Convenience object for consumers that prefer a single config value. */
export const CURRENCY_CONFIG = {
  currencyCode: CURRENCY_CODE,
  currencySymbol: CURRENCY_SYMBOL,
  locale: CURRENCY_LOCALE,
} as const;

/** Default currency for the POS. QuickBooks Online remains the accounting master. */
export const DEFAULT_CURRENCY = CURRENCY_CODE;

/**
 * How a payment method reads to a person — on the invoice, the receipt and the
 * screen alike.
 *
 * Shared rather than repeated per surface: the same sale was showing "Cash" in
 * the app and "CASH" on the server-rendered invoice, which is the sort of
 * difference that makes a document look machine-generated.
 */
export const PAYMENT_METHOD_LABELS: Record<string, string> = {
  CASH: 'Cash',
  CARD: 'Card',
  BANK_TRANSFER: 'Bank transfer',
  QR_PAYMENT: 'QR payment',
  CHECK: 'Cheque',
  STORE_CREDIT: 'Store credit',
  OTHER: 'Other',
};

/** A method's label, falling back to the raw code for anything unrecognised. */
export function paymentMethodLabel(method: string): string {
  return PAYMENT_METHOD_LABELS[method] ?? method;
}

/**
 * How a sale's payment status reads to a user.
 *
 * PARTIAL and UNPAID deliberately read the SAME. The shop does not distinguish
 * "some of it is owed" from "all of it is owed" — either way the sale went out
 * on credit and money is outstanding, and that is the only thing anyone acts on.
 * The enum keeps them apart because the arithmetic needs to (a part payment is
 * not a fresh credit sale); the screen does not.
 */
export const PAYMENT_STATUS_LABELS: Record<string, string> = {
  PAID: 'Paid',
  PARTIAL: 'Credit / Unpaid',
  UNPAID: 'Credit / Unpaid',
  REFUNDED: 'Refunded',
};

/** A payment status's label, falling back to the raw code for anything unrecognised. */
export function paymentStatusLabel(status: string): string {
  return PAYMENT_STATUS_LABELS[status] ?? status;
}

/**
 * How an unpaid balance reads where a payment method is expected. Not a
 * `PaymentMethod` — nothing is tendered on credit, which is the whole point —
 * so it exists only at render time.
 */
export const CREDIT_METHOD_LABEL = 'Credit';

/**
 * How a sale's payment method reads on a customer-facing document.
 *
 * While a balance remains the sale is running on credit, so "Credit" belongs in
 * the list — alongside anything already tendered, because a customer who paid
 * half in cash did use cash. Once the sale is settled the list is simply what
 * they paid with, so a bill reprinted after settlement names the real method(s)
 * and no longer mentions credit.
 *
 * Shared so the printed bill, the PDF and the thermal receipt cannot disagree
 * about the same sale.
 */
export function documentPaymentMethods(
  payments: ReadonlyArray<{ method: string }>,
  balanceAmount: number,
): string {
  // Deduped: a split payment across two cards should read "Card", not "Card, Card".
  const labels = [...new Set(payments.map((p) => paymentMethodLabel(p.method)))];
  if (balanceAmount > 0) labels.push(CREDIT_METHOD_LABEL);
  // Nothing tendered and nothing owed cannot normally happen; a dash is honest
  // if it ever does, where "Credit" would be a lie.
  return labels.length > 0 ? labels.join(', ') : '—';
}
