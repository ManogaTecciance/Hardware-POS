import type { Session } from '@/lib/auth';
import { fetchSettings } from '@/lib/settings-api';

/**
 * The tenant's display currency, cached for synchronous formatting.
 *
 * Money is formatted in dozens of render paths that cannot each await the
 * settings API, so the resolved code is cached the same way the document
 * profile is (module memory for this tab, LocalStorage so the first paint
 * after a reload is already right).
 *
 * `AppSettings.currency` has existed and been API-writable all along; the
 * restaurant surface simply defaulted every formatter to `'LKR'`. The default
 * below keeps that behaviour for a tenant who has never set one, so nothing
 * changes for the pilot.
 */

const LS_KEY = 'axlopos.currency';
const FALLBACK = 'LKR';
/** ISO-4217 shape; re-validated on read because LocalStorage is user-editable. */
const CODE = /^[A-Z]{3}$/;

let active: string | null = null;

export function rememberCurrency(code: string | null | undefined): void {
  const next = (code ?? '').trim().toUpperCase();
  if (!CODE.test(next)) return;
  active = next;
  try {
    localStorage.setItem(LS_KEY, next);
  } catch {
    /* storage unavailable — the in-memory value still serves this tab */
  }
}

/** Synchronous read for formatters. Never throws, never awaits. */
export function getActiveCurrency(): string {
  if (active) return active;
  try {
    const stored = localStorage.getItem(LS_KEY) ?? '';
    if (CODE.test(stored)) {
      active = stored;
      return stored;
    }
  } catch {
    /* fall through to the default */
  }
  return FALLBACK;
}

/** Forget the cached currency — the next tenant on this device may differ. */
export function forgetCurrency(): void {
  active = null;
  try {
    localStorage.removeItem(LS_KEY);
  } catch {
    /* nothing to do */
  }
}

/**
 * Resolve the tenant's currency once per shell. Failures are swallowed: a
 * settings outage must not stop the app rendering money, it just renders it in
 * the last known (or default) currency.
 */
export async function primeTenantCurrency(session: Session): Promise<void> {
  try {
    const settings = await fetchSettings(session);
    rememberCurrency(settings.currency);
  } catch {
    /* keep whatever is cached */
  }
}
