/**
 * Currency formatting shared between the web front-end and the API.
 *
 * All monetary values are stored internally as plain numbers (major units,
 * rounded to 2 decimals) — never as formatted strings. Formatting happens only
 * at the display/print boundary through {@link formatCurrency}.
 */
import { CURRENCY_CODE, CURRENCY_LOCALE, CURRENCY_SYMBOL } from './constants.js';

/**
 * Format a numeric amount as Sri Lankan Rupees, e.g. `1250` → `"Rs. 1,250.00"`.
 *
 * Uses `Intl.NumberFormat` with the `en-LK` locale and `LKR` currency (comma
 * thousands separator, period decimal, two fraction digits) and renders the
 * `Rs.` display symbol. `currencyDisplay: 'code'` keeps the output stable across
 * ICU versions/runtimes (avoids SSR/CSR hydration mismatches) before we swap the
 * ISO code for the display symbol.
 */
export function formatCurrency(value: number, currency: string = CURRENCY_CODE): string {
  const amount = Number.isFinite(value) ? value : 0;
  const code = /^[A-Z]{3}$/.test(currency) ? currency : CURRENCY_CODE;
  const formatted = new Intl.NumberFormat(CURRENCY_LOCALE, {
    style: 'currency',
    currency: code,
    currencyDisplay: 'code',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);

  // Only LKR has a display symbol here; every other tenant currency renders as
  // its ISO code, which is honest and stable across ICU versions. Substituting
  // an invented symbol would be worse than showing "AED 1,250.00".
  if (code !== CURRENCY_CODE) return formatted;
  // Replace the ISO code (with any adjoining whitespace) with the "Rs." symbol.
  return formatted.replace(new RegExp(`${CURRENCY_CODE}\\s?`), `${CURRENCY_SYMBOL} `).trim();
}
