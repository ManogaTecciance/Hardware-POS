/**
 * Small runtime helpers shared by the POS workspace and the dine-in
 * order-entry screen.
 */
import type { DraftLine } from './pos-types';

/**
 * Prefer the platform's UUID generator; fall back to a Math.random-based
 * pseudo-key for browsers where `crypto.randomUUID` is missing. Never used
 * as a database id — this is a local React `key` and an idempotency-key
 * seed.
 */
export function cryptoRandomKey(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `key-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Draft subtotal in the caller's currency. Snapshot pricing — the server
 * still owns the authoritative total; see `DraftLine` doc.
 */
export function draftSubtotal(lines: readonly DraftLine[]): number {
  return lines.reduce((sum, r) => {
    const unit = Number(r.unitPrice);
    const mods = r.modifiers.reduce((s, m) => s + Number(m.priceDelta), 0);
    return sum + r.quantity * (unit + mods);
  }, 0);
}
