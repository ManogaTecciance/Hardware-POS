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

/**
 * The identity under which two draft lines are THE SAME ORDER LINE and may
 * merge into one row with a summed quantity (2026-08-18, PO decision).
 *
 * Lines merge only when the configuration is byte-identical:
 *  - same source and same product AND same variant — a Medium and a Large
 *    steak stay separate lines;
 *  - same modifier set (order-independent) — extra cheese ≠ plain;
 *  - same special instructions — "no onions" never merges into a plain one;
 *  - and NO line discount on either side — merging across discounts would
 *    change money, so a discounted line never merges (returns null).
 *
 * The price snapshots (unitPrice, per-modifier deltas) are part of the key,
 * deliberately: if the menu price changed between two taps, the two lines
 * carry different display money and merging them would misprice one of
 * them. Distinct snapshots → distinct lines; the server still owns the
 * authoritative money on submit either way.
 */
export function draftLineMergeKey(line: DraftLine): string | null {
  if (line.discount) return null;
  const modifiers = line.modifiers
    .map((m) => `${m.optionId}@${m.priceDelta}`)
    .sort()
    .join(',');
  return [
    line.sourceKind ?? 'MENU_ITEM',
    line.menuItemId,
    line.productId ?? '',
    line.productVariantId ?? '',
    line.unitPrice,
    modifiers,
    line.specialInstructions.trim(),
  ].join('|');
}

/**
 * Add a line to the draft, merging into an existing identical line
 * (quantity summed, existing row and key kept — no re-mount, no reorder)
 * or appending when no identical line exists. The single add path for both
 * the counter POS and the dine-in order entry.
 */
export function addDraftLine(rows: DraftLine[], line: DraftLine): DraftLine[] {
  const key = draftLineMergeKey(line);
  if (key !== null) {
    const idx = rows.findIndex((r) => draftLineMergeKey(r) === key);
    if (idx >= 0) {
      return rows.map((r, i) =>
        i === idx ? { ...r, quantity: r.quantity + line.quantity } : r,
      );
    }
  }
  return [...rows, line];
}
