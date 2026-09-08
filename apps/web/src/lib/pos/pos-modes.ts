import type { PosMode } from '@/components/pos/pos-mode-selector';
import { Permission } from '@/lib/permissions';

/**
 * D93 — which POS modes a user can actually work, and which one a link may open.
 *
 * A pure resolver, in the shape D28/D31 asks for: the decision lives in one
 * place and the component reads a result. It was inline in
 * `pos-counter-workspace.tsx`, where nothing could test it without rendering
 * the whole workspace — which is why the deep-link hole below went unnoticed
 * until POS became a visible destination for the till.
 *
 * Nothing here is authorization. The server refuses what it always refused;
 * this only decides what the screen offers, so that an operator is never
 * handed a door that opens onto a 403 (D31 — hiding is usability).
 */

/**
 * The modes this permission set can complete, in the order they are offered.
 *
 * Each mode is keyed to the capability that FINISHES it, not to one that
 * merely starts it:
 *   DINE_IN     — ORDER_SEND_TO_KITCHEN: a round that cannot reach the kitchen
 *                 is not a dine-in order.
 *   TAKEAWAY    — TAKEAWAY_CREATE.
 *   THIRD_PARTY — TAKEAWAY_CREATE plus PAYMENT_COLLECT. Server-side a delivery
 *                 IS a takeaway (same endpoint, same permission, address in the
 *                 notes), so the second half is a usability judgement rather
 *                 than an enforced boundary: taking an order you will not be
 *                 there to settle belongs to whoever settles it (D87).
 */
export function availablePosModes(
  hasPermission: (permission: Permission) => boolean,
): PosMode[] {
  const modes: PosMode[] = [];
  if (hasPermission(Permission.ORDER_SEND_TO_KITCHEN)) modes.push('DINE_IN');
  if (hasPermission(Permission.TAKEAWAY_CREATE)) {
    modes.push('TAKEAWAY');
    if (hasPermission(Permission.PAYMENT_COLLECT)) modes.push('THIRD_PARTY');
  }
  return modes;
}

/**
 * The mode the COUNTER WORKSPACE may open from a `?mode=` deep link, or `null`
 * for "ask".
 *
 * Scoped deliberately, and the scope matters: `/pos?mode=third-party` carrying
 * an `externalOrderId` returns the third-party INSPECTOR earlier in
 * `app/(app)/pos/page.tsx`, before this workspace is constructed, so this
 * resolver never sees it. That screen is a read-only inspector for an inbound
 * partner order gated server-side on different permissions
 * (`PLATFORM_PROFILE_READ` to view, `PLATFORM_PROFILE_MANAGE` to accept) — a
 * different feature that happens to share the `?mode=` prefix. Routing it
 * through here would apply the wrong gate.
 *
 * `?mode=` survives a bookmark, a shared link and the dashboard's `/takeaway`
 * hop, so it can name a mode this operator cannot work. Since D93 the till has
 * a POS rail entry, which makes `/pos?mode=dine-in` an ordinary thing to
 * receive from a colleague — and unclamped it opens a cashier into a dine-in
 * workspace whose Confirm & send the server refuses, three taps and one
 * composed order later. Refusing at the door costs a single tap.
 */
export function resolveInitialPosMode(
  requested: PosMode | null,
  available: readonly PosMode[],
): PosMode | null {
  if (!requested) return null;
  return available.includes(requested) ? requested : null;
}

/**
 * The single mode to open without asking, or `null` when there is a choice.
 *
 * A chooser with one card is not a choice; a chooser with none is a dead end
 * that says nothing about why.
 */
export function solePosMode(available: readonly PosMode[]): PosMode | null {
  return available.length === 1 ? available[0]! : null;
}
