import { CURRENCY_SYMBOL, formatCurrency } from '@hardware-pos/shared';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Merge conditional class names, de-duplicating conflicting Tailwind utilities. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/**
 * Format a number as currency for display (Sri Lankan Rupees, e.g. `Rs. 1,250.00`).
 *
 * All POS transactions are treated as LKR, so the optional `currency` argument is
 * retained only for call-site compatibility and no longer affects the output.
 */
export function formatMoney(amount: number, _currency?: string): string {
  return formatCurrency(amount);
}

/**
 * Compact currency for dashboard statistics: values from a million up render
 * as `Rs. 2.3657mil` (up to four decimals, trailing zeros trimmed); smaller
 * values fall back to the full `Rs. 1,250.00` form.
 */
export function formatMoneyCompact(amount: number): string {
  if (!Number.isFinite(amount) || Math.abs(amount) < 1_000_000) {
    return formatCurrency(amount);
  }
  const mils = (amount / 1_000_000).toFixed(4).replace(/\.?0+$/, '');
  return `${CURRENCY_SYMBOL} ${mils}mil`;
}

/** Round to 2 decimal places (currency). */
export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
