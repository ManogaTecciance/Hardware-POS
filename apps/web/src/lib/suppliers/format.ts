/** Supplier (vendor) display formatting helpers — pure and unit-tested. */

import { formatMoney } from '@/lib/utils';

/** Initials for the avatar fallback, e.g. "Lanka Hardware" → "LH". */
export function supplierInitials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

/** Money or an explicit fallback when the value is unknown (never fake zeros). */
export function formatBalance(value: number | null | undefined, fallback = '—'): string {
  return value == null ? fallback : formatMoney(value);
}

/** A vendor's location line: "Colombo, Sri Lanka" (skips missing parts). */
export function formatLocation(
  city: string | null,
  province: string | null,
  country: string | null,
): string {
  return [city, province, country].filter(Boolean).join(', ') || '—';
}

/** Date-only display for ISO timestamps (opening balance as-of, last synced). */
export function formatDateOnly(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-GB', { year: 'numeric', month: 'short', day: 'numeric' });
}
