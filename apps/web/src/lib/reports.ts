/**
 * Retail reports API client (Phase 8).
 *
 * Thin wrappers around the shared `api` object, one per audited backend route.
 *
 * **Money arrives as exact decimal strings and stays that way.** The server is
 * the money engine (D59): every figure here was summed by Postgres as a
 * `Decimal` and rendered with `Decimal.toFixed()`. Parsing `"1234.50"` back into
 * a JavaScript number to re-format it would reintroduce, on the client, exactly
 * the defect audit item A8 describes on the server. `formatReportMoney` below
 * punctuates the string it is given and never does arithmetic on it.
 */

import { CURRENCY_CODE, CURRENCY_SYMBOL } from '@hardware-pos/shared';

import { api } from './api';
import type { Session } from './auth';
import { getActiveCurrency } from './tenant-money';

function auth(session: Session): { token: string; tenantId: string } {
  return { token: session.token, tenantId: session.user.tenantId };
}

/** `YYYY-MM-DD` on both ends; the server widens a bare date to the whole day. */
export interface RetailReportRange {
  from: string;
  to: string;
}

export interface VariantSalesRow {
  productId: string | null;
  productName: string;
  productVariantId: string | null;
  /** `"Medium / Black"`, or `null` for a product sold without variants. */
  variantName: string | null;
  sku: string | null;
  /** 3dp, as a string — quantities are `Decimal(12,3)` on the server. */
  quantitySold: string;
  revenue: string;
  tax: string;
  discount: string;
}

export interface VariantSalesReport {
  from: string;
  to: string;
  rows: VariantSalesRow[];
  totals: { quantitySold: string; revenue: string; tax: string; discount: string };
}

export function salesByVariant(
  session: Session,
  range: RetailReportRange,
): Promise<VariantSalesReport> {
  const q = new URLSearchParams({ from: range.from, to: range.to });
  return api.get<VariantSalesReport>(`/sales/reports/by-variant?${q}`, auth(session));
}

export interface TaxRateRow {
  /** `"18.00"`, or `null` for tax that could not be attributed to a rate. */
  ratePercent: string | null;
  /** `"18%"`, or the reason there is no rate. */
  rateLabel: string;
  taxable: string;
  tax: string;
}

export interface TaxByRateReport {
  from: string;
  to: string;
  rows: TaxRateRow[];
  totals: { taxable: string; tax: string };
  /** At least one sale in the range predates per-line rates. */
  hasUnattributed: boolean;
}

export function taxByRate(
  session: Session,
  range: RetailReportRange,
): Promise<TaxByRateReport> {
  const q = new URLSearchParams({ from: range.from, to: range.to });
  return api.get<TaxByRateReport>(`/sales/reports/tax-by-rate?${q}`, auth(session));
}

/**
 * Group the integer part of an exact decimal string, e.g. `"12345.60"` →
 * `"Rs. 12,345.60"`.
 *
 * String in, string out. No `Number()`, no `toFixed`, no rounding: the value
 * displayed is byte-for-byte the value the server computed, which is what makes
 * a printed report and a re-run of the same query agree to the cent.
 */
export function formatReportMoney(value: string, currency = getActiveCurrency()): string {
  // Same rule as the shared `formatCurrency`: only the home currency has a
  // display symbol; every other tenant currency renders as its ISO code, which
  // is honest and stable rather than an invented glyph.
  const symbol = currency === CURRENCY_CODE ? CURRENCY_SYMBOL : currency;
  const negative = value.startsWith('-');
  const [whole = '0', fraction] = (negative ? value.slice(1) : value).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${symbol} ${grouped}${fraction ? `.${fraction}` : ''}`;
}

/**
 * `"3.000"` → `"3"`, `"1.500"` → `"1.5"`.
 *
 * Quantities are `Decimal(12,3)` because loose goods are sold by weight, but a
 * shop counting shirts should not read `12.000`. Trailing zeroes are trimmed
 * from the string; the digits themselves are never recomputed.
 */
export function formatReportQuantity(value: string): string {
  if (!value.includes('.')) return value;
  return value.replace(/0+$/, '').replace(/\.$/, '');
}

/** Where a margin row's unit cost came from. */
export type CostSource = 'VARIANT_AVERAGE' | 'PRODUCT_AVERAGE' | 'LATEST_PURCHASE' | 'UNKNOWN';

export interface MarginRow {
  productId: string | null;
  productName: string;
  productVariantId: string | null;
  variantName: string | null;
  sku: string | null;
  quantitySold: string;
  revenue: string;
  /** `null` when nothing has ever been received — unknown, not zero. */
  cost: string | null;
  margin: string | null;
  marginPercent: string | null;
  costSource: CostSource;
}

export interface MarginReport {
  from: string;
  to: string;
  rows: MarginRow[];
  /** Over the rows whose cost is known. */
  totals: { revenue: string; cost: string; margin: string; marginPercent: string | null };
  unknownCost: { rows: number; revenue: string };
}

export function margin(session: Session, range: RetailReportRange): Promise<MarginReport> {
  const q = new URLSearchParams({ from: range.from, to: range.to });
  return api.get<MarginReport>(`/sales/reports/margin?${q}`, auth(session));
}

/** How a row's cost was arrived at, in words a shopkeeper reads. */
export const COST_SOURCE_LABELS: Record<CostSource, string> = {
  VARIANT_AVERAGE: 'Average cost',
  PRODUCT_AVERAGE: 'Average cost (product)',
  LATEST_PURCHASE: 'Last purchase',
  UNKNOWN: 'Never received',
};
