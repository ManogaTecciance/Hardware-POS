import type { Session } from '@/lib/auth';

import { diningAreas, openTables, restaurantTables, tableSessions } from './api';
import type { DiningAreaView, OpenTableView, RestaurantTableView } from './types';

/**
 * D150 — "which session is the POS taking orders onto", resolved in one place.
 *
 * The dine-in POS learns its table two ways now: the waiter picks one from the
 * panel's grid, or the floor plan hands one over in the URL
 * (`/pos?mode=dine-in&sessionId=…`). Both need the SAME two answers — what the
 * table is called, and what the session's shape is — and the label is the half
 * that is easy to get wrong: no endpoint returns it. `GET /open-sessions`
 * carries a `tableId`, and the name behind that id lives in the area listings
 * (a physical table) or the open-tables listing (an arrangement, which belongs
 * to no area and is therefore absent from every per-area read).
 *
 * So it is resolved here rather than twice in two components, per D28/D31: the
 * decision lives in one place and the component reads a result. A deep link
 * that fell back to the session number would put "TS-000042" on the strip, the
 * bill sheet and the POS header — the one thing the waiter cannot recognise.
 */

/** The session the POS is currently taking orders onto. */
export interface ActiveTableSession {
  id: string;
  sessionNumber: string;
  tableLabel: string;
  openedAt: string;
  guestCount: number | null;
  /** Lazily created on the first send — null until then. */
  orderId: string | null;
}

/**
 * The fields of an open-session row this resolver reads. Deliberately a subset
 * of `OpenSessionView`: the floor's `readyTicketIds` and the session's version
 * have nothing to do with naming a tab.
 */
export interface OpenSessionRow {
  id: string;
  sessionNumber: string;
  tableId: string;
  openedAt: string;
  guestCount: number | null;
  /** D104 — this tab's own name; null unless an arrangement is being shared. */
  tabName: string | null;
  activeOrderId: string | null;
  /**
   * D151 — whose session this is, and what to call them. The picker opens on
   * the caller's own tables and offers the floor, so it needs both: the id to
   * decide, the name to say.
   */
  waiterUserId: string | null;
  waiterName: string | null;
}

/**
 * D104 — what a tab is called: the table, then this party's own name.
 *
 * Mirrors `withTabName` on the server (`apps/api/src/common/place-label.ts`),
 * which composes the same thing for the kitchen ticket and the bill. The two
 * are deliberately separate implementations of a one-line rule rather than a
 * shared package: what the waiter reads on a chip and what the pass reads on a
 * ticket are allowed to diverge later, and a shared helper would make that
 * change look riskier than it is.
 */
export function tabLabel(tableName: string, tabName: string | null | undefined): string {
  const tab = tabName?.trim();
  return tab ? `${tableName} · ${tab}` : tableName;
}

/** Every table on the branch, in the shape the picker and the labels need. */
export interface BranchFurniture {
  /** Areas in `position` order. */
  areas: DiningAreaView[];
  tablesByArea: Map<string, RestaurantTableView[]>;
  /** D49/D50 — arrangements, which belong to no area. */
  joined: OpenTableView[];
  /** tableId → display name, for physical tables AND arrangements. */
  labels: Map<string, string>;
}

/**
 * Load the branch's furniture, and the label map over all of it.
 *
 * EVERY area is loaded regardless of any filter the caller applies, and the
 * label map is built from every table in them, because a session in a
 * filtered-out area would otherwise lose its name entirely — leaving the
 * waiter a chip labelled with a bare session number and no way to tell which
 * table it is. A filter narrows what is DISPLAYED, never what is known.
 *
 * D91 — and every table is kept, not just the AVAILABLE ones: discarding the
 * rest here would make "Open" a destination that can only ever be empty.
 *
 * Each read swallows its own failure. A branch that has never joined tables
 * must not lose its floor plan to a 403 on a feature it does not use.
 */
export async function loadBranchFurniture(
  session: Session,
  branchId: string,
): Promise<BranchFurniture> {
  const [areaRows, joined] = await Promise.all([
    diningAreas.list(session, branchId, false).catch(() => [] as DiningAreaView[]),
    openTables.list(session, branchId).catch(() => [] as OpenTableView[]),
  ]);
  const areas = areaRows.slice().sort((a, b) => a.position - b.position);
  const lists = await Promise.all(
    areas.map((a) => restaurantTables.list(session, a.id, false).catch(() => [])),
  );

  const labels = new Map<string, string>();
  const tablesByArea = new Map<string, RestaurantTableView[]>();
  areas.forEach((a, i) => {
    const rows = lists[i] ?? [];
    for (const t of rows) labels.set(t.id, t.label ?? t.code);
    tablesByArea.set(a.id, rows);
  });
  /*
   * D49/D50 — arrangements go into the SAME label map. A session on one is
   * returned by `listOpen` like any other, so without this every caller falls
   * through to the session number and the waiter is asked to recognise their
   * party by "TS-000042".
   */
  for (const t of joined) labels.set(t.id, t.label ?? t.code);

  return { areas, tablesByArea, joined, labels };
}

/**
 * One open-session row as the POS's active session.
 *
 * D104 — two tabs on one arrangement resolve to the same table name, so
 * without the tab name the strip, the bill sheet and the POS header would all
 * read identically for two different parties.
 */
export function activeSessionFrom(
  row: OpenSessionRow,
  labels: Map<string, string>,
): ActiveTableSession {
  const table = labels.get(row.tableId);
  return {
    id: row.id,
    sessionNumber: row.sessionNumber,
    tableLabel: table ? tabLabel(table, row.tabName) : row.sessionNumber,
    openedAt: row.openedAt,
    guestCount: row.guestCount,
    orderId: row.activeOrderId,
  };
}

export type LinkedSessionResult =
  | { ok: true; active: ActiveTableSession }
  /**
   * `not-open` is a state, not a failure: the party was billed while the
   * waiter walked over, or the link is an hour old. The caller is handed the
   * Sale so it can offer the bill instead of a dead end.
   */
  | { ok: false; reason: 'not-open'; finalSaleId: string | null }
  | { ok: false; reason: 'unreachable'; message: string };

/**
 * Resolve a `sessionId` handed over in a URL into the POS's active session.
 *
 * Read from `GET /open-sessions` rather than `GET /table-sessions/:id`, and the
 * choice is load-bearing twice over: that listing is D70-scoped, so a session
 * this user may not work is simply absent (the server would refuse the round
 * anyway, and refusing at the door beats a 403 three taps in), and it is the
 * only read that carries `activeOrderId` — without it the first send would
 * create a SECOND order on a session that already has one.
 */
export async function resolveLinkedSession(
  session: Session,
  branchId: string,
  sessionId: string,
): Promise<LinkedSessionResult> {
  let rows: OpenSessionRow[];
  try {
    rows = await tableSessions.listOpen(session, branchId);
  } catch (err) {
    return {
      ok: false,
      reason: 'unreachable',
      message: err instanceof Error ? err.message : 'Could not load this table',
    };
  }

  const row = rows.find((r) => r.id === sessionId);
  if (!row) {
    // Closed, cancelled, or someone else's. `get` is a cheap second read that
    // separates "already billed" (offer the bill) from "gone".
    const closed = await tableSessions.get(session, sessionId).catch(() => null);
    return { ok: false, reason: 'not-open', finalSaleId: closed?.finalSaleId ?? null };
  }

  const { labels } = await loadBranchFurniture(session, branchId);
  return { ok: true, active: activeSessionFrom(row, labels) };
}
