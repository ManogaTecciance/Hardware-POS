import { isAdminLevelRole, type UserRole } from '@hardware-pos/shared';

import type { OpenSessionView } from './types';

/**
 * D156 — "my tables" or "the whole floor", resolved in one place.
 *
 * Table service has two questions about a running session and they have
 * different answers: *which tables am I responsible for* (nearly always what a
 * waiter wants) and *what is happening in this room* (what they want when
 * covering a break, handing over a shift, or answering a guest who flagged
 * them down on the way past). Mainstream POS answers both with one control
 * defaulted to the first — My tables / All tables — and that is what this
 * resolves for the floor plan and the POS picker, so the two screens cannot
 * drift into different rules.
 *
 * A pure resolver, per D28/D31: the screens read a result. The previous shape
 * had no resolver because there was no choice — the server simply withheld
 * other waiters' sessions (D70), which is what D156 reversed.
 */

export type SessionOwnerScope = 'mine' | 'all';

/**
 * D157c — whose screens carry the my/all control at all.
 *
 * "My tables" and "My orders" are a SERVER's question: which of the room am I
 * responsible for. An owner does not serve tables — they watch the floor — so
 * for them the control was offering a filter over a set that is theirs only by
 * accident (a table they opened while covering, or while testing), and the
 * D157b default then opened them on that accident instead of on the room.
 *
 * Read off the enum role rather than off permissions, and that is the whole
 * point: an owner holds EVERY permission, including the waiter's, so no
 * permission can tell the two apart. `isAdminLevelRole` is the same predicate
 * the API uses for "may step past an operational guard-rail" (OWNER, ADMIN,
 * SALESPERSON). A restaurant Waiter and Cashier both carry the enum CASHIER, so
 * they keep the control — the cashier genuinely has their own takeaway orders.
 */
export function supervisesTheFloor(role: UserRole): boolean {
  return isAdminLevelRole(role);
}

/**
 * Which scope to show: what the operator chose, or MINE.
 *
 * `chosen` is null until a chip is tapped, and then it WINS for the rest of the
 * visit — an operator who asked for the floor must not be pulled back to their
 * own tables by the next poll.
 *
 * D157b — the default is "mine", full stop, and nothing widens it on the
 * operator's behalf.
 *
 * It used to depend on the data: mine when the caller had a session, all when
 * they had none, on the reasoning that an empty "my tables" reads as a broken
 * screen. That produced two flickers in a row, because the count arrives after
 * the first paint — D157a fixed the first direction (opening on ALL and
 * snapping to mine) and left the second, which the PO then reported: "it's
 * working backward — first my tables, then automatically all tables".
 *
 * A default that moves after the screen has already answered the question is
 * worse than an empty list, so the empty list is what the screens now show —
 * with the All chip beside it carrying the branch count, and (on the queue) a
 * one-tap way over. The operator is told what they are looking at and offered
 * the alternative, instead of being moved to it.
 */
export function resolveOwnerScope(chosen: SessionOwnerScope | null): SessionOwnerScope {
  return chosen ?? 'mine';
}

/** Whether this session belongs to the signed-in user. */
export function isMySession(session: { waiterUserId: string | null }, userId: string): boolean {
  return session.waiterUserId === userId;
}

/**
 * The sessions a scope shows, keyed by table as the callers hold them.
 *
 * Filtering the MAP rather than each call site is deliberate: the floor reads
 * it in three places (a table card, an arrangement's tabs, the ready badge) and
 * a scope applied in two of them is a table that is hidden but still rings.
 *
 * An emptied list drops its key entirely, so "has this table a session I can
 * see" stays a single `.get()` test rather than a length check everywhere.
 */
export function sessionsVisibleTo(
  byTable: ReadonlyMap<string, OpenSessionView[]>,
  scope: SessionOwnerScope,
  userId: string,
): Map<string, OpenSessionView[]> {
  if (scope === 'all') return new Map(byTable);
  const out = new Map<string, OpenSessionView[]>();
  for (const [tableId, sessions] of byTable) {
    const mine = sessions.filter((s) => isMySession(s, userId));
    if (mine.length > 0) out.set(tableId, mine);
  }
  return out;
}

/** How many of these sessions are the signed-in user's — the chip's count. */
export function countMine(
  byTable: ReadonlyMap<string, OpenSessionView[]>,
  userId: string,
): number {
  let n = 0;
  for (const sessions of byTable.values()) {
    n += sessions.filter((s) => isMySession(s, userId)).length;
  }
  return n;
}

/** How many sessions are running in total — the All chip's count. */
export function countAll(byTable: ReadonlyMap<string, OpenSessionView[]>): number {
  let n = 0;
  for (const sessions of byTable.values()) n += sessions.length;
  return n;
}

/**
 * D157 — what to call an ORDER that is not yours, on the Orders queue.
 *
 * Same rule as {@link otherWaiterLabel} and deliberately the same silence: a
 * row of your own needs no name (it would be your own name down the whole
 * list), and a row nobody is attributed to — every third-party order — must
 * not be labelled with a guess. The field pair differs because the person
 * behind a takeaway order is whoever keyed it at the counter, not a waiter.
 */
export function staffLabel(
  order: { staffUserId: string | null; staffName: string | null },
  userId: string,
): string | null {
  if (order.staffUserId === userId) return null;
  return order.staffName?.trim() || null;
}

/**
 * What to call a session that is not yours. Null when it is yours (nothing to
 * say) or when the server could not name the waiter — a card must not claim
 * "Unknown" is serving the table.
 */
export function otherWaiterLabel(
  session: { waiterUserId: string | null; waiterName: string | null },
  userId: string,
): string | null {
  if (isMySession(session, userId)) return null;
  return session.waiterName?.trim() || null;
}
