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
