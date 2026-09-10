'use client';

import { ChevronDown, Loader2, RefreshCw, Users, UtensilsCrossed } from 'lucide-react';
import * as React from 'react';

import { AreaChip } from '@/components/restaurant/area-chip';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ChipRow } from '@/components/ui/chip-row';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { type Session } from '@/lib/auth';
import {
  activeSessionFrom,
  loadBranchFurniture,
  tabLabel,
  type ActiveTableSession,
  type OpenSessionRow,
} from '@/lib/restaurant/active-session';
import { tableSessions } from '@/lib/restaurant/api';
import {
  isMySession,
  otherWaiterLabel,
  resolveOwnerScope,
  supervisesTheFloor,
  type SessionOwnerScope,
} from '@/lib/restaurant/session-ownership';
import { TABLE_STATUS_LABELS, formatElapsed } from '@/lib/restaurant/labels';
import { seatsFree } from '@/lib/restaurant/types';
import type {
  DiningAreaView,
  OpenTableView,
  RestaurantTableStatus,
  RestaurantTableView,
} from '@/lib/restaurant/types';

export type { ActiveTableSession };

/**
 * D92 — the running sessions, addressed like a dining area.
 *
 * The chip strip carries ONE selection: a floor, or this. An open table lives
 * here and nowhere else, and a free one lives in its area and nowhere else, so
 * every table on the branch is in exactly one place and no chip combination
 * can hide it (D91 shipped All/Free/Open chips beside the areas — two
 * selections, six combinations, and the PO wanted one row of destinations).
 *
 * The sentinel is client-only state that is never stored or sent, and area ids
 * are cuids, so it cannot collide with one. This is deliberately NOT the
 * `__walk_in__` pattern (D92, below): that string is a database row's name
 * doing duty as an identifier.
 */
const OPEN_VIEW = '__open__';

/*
 * D49/D50/D104 — where the joined tables live.
 *
 * An arrangement has `areaId = null`, so it appears in NO area's table list and
 * was unreachable from this screen entirely: the picker builds its grid by
 * looping the areas, and `GET /restaurant/dining-areas/:areaId/tables` filters
 * on `areaId`. A waiter could create one on the Tables screen and then never
 * find it in the POS.
 *
 * They live under OPEN — always, seated or not — as their own group above the
 * floors. An earlier pass gave them a separate "Joined" chip; the PO wanted
 * them under Open, and on reflection that is also the truer reading of D92's
 * partition: every table on the branch is in exactly one place, and an
 * arrangement's place is Open. Unlike a physical table, it does not move when
 * the party sits down — under D104 an arrangement can be BOTH occupied and
 * seatable, so filing it by status would make it flicker between destinations
 * as parties come and go.
 */

/*
 * "Open" means a session is running on the table, which is what "open table"
 * means everywhere else in this product (the floor plan, `/open-tables`, the
 * bill). It is deliberately not a status the waiter has to know the name of:
 * SEATED, OCCUPIED and BILLING are all one party at one table from the floor's
 * point of view, and asking a waiter to distinguish them to find their table
 * would hide things for reasons they cannot see.
 */
const OPEN_STATUSES: readonly RestaurantTableStatus[] = ['SEATED', 'OCCUPIED', 'BILLING'];

function isOpenTable(status: RestaurantTableStatus): boolean {
  return OPEN_STATUSES.includes(status);
}

// `tabLabel`, `ActiveTableSession` and the open-session row moved to
// `lib/restaurant/active-session.ts` (D150) — the floor plan's deep link needs
// the same label resolution this picker does, and it has no picker to get it
// from. Re-exported above so existing importers are unchanged.

interface Props {
  session: Session;
  branchId: string;
  active: ActiveTableSession | null;
  onPick: (picked: ActiveTableSession) => void;
  /** D71 — opens the bill sheet: full order, totals, split, close. */
  onOpenBill: () => void;
  /** D150 — opens the rounds sheet: what is already on the table, and voids. */
  onOpenRounds: () => void;
  /** Rounds already sent to the kitchen on this session, for the strip. */
  roundsSent: number;
  /**
   * D150 — the table was chosen BEFORE this screen, on the floor plan, and the
   * POS is bound to it for this visit. The picker is then not collapsed, it is
   * absent: offering "change table" on a screen reached by tapping one table's
   * View order is an answer to a question nobody asked, and the way back is
   * the floor, which the header carries.
   */
  locked?: boolean;
}

/**
 * D69 — the dine-in session block.
 *
 * The one thing table service needs that a counter order does not: the order
 * belongs to a TABLE, over a period, across several rounds. So before a
 * waiter can compose anything they answer "which table", and afterwards they
 * answer "are they finished" — and between those two the screen is the
 * ordinary POS.
 *
 * Once a table is chosen the picker COLLAPSES to a one-line strip, because
 * from that moment the menu is what the waiter is looking at and a wall of
 * table chips is just pushing it off the screen. The strip re-opens it, so
 * moving to another table never means leaving the screen.
 */
export function TableSessionPanel({
  session,
  branchId,
  active,
  onPick,
  onOpenBill,
  onOpenRounds,
  roundsSent,
  locked = false,
}: Props) {
  const [expanded, setExpanded] = React.useState(false);

  // Choosing a table collapses the picker; losing the session (a close, or a
  // mode change) must not leave it collapsed with nothing to show.
  React.useEffect(() => {
    if (active) setExpanded(false);
  }, [active]);

  // A locked panel never shows the grid — not even while the link resolves,
  // where a flash of "Which table?" is exactly the question D150 removed.
  const showPicker = !locked && (active === null || expanded);

  return (
    <div className="space-y-2">
      {active ? (
        <ActiveStrip
          active={active}
          roundsSent={roundsSent}
          expanded={expanded}
          canChangeTable={!locked}
          onToggle={() => setExpanded((v) => !v)}
          onOpenBill={onOpenBill}
          onOpenRounds={onOpenRounds}
        />
      ) : null}
      {showPicker ? (
        <Picker
          session={session}
          branchId={branchId}
          activeId={active?.id ?? null}
          onPick={(picked) => {
            setExpanded(false);
            onPick(picked);
          }}
        />
      ) : null}
    </div>
  );
}

function ActiveStrip({
  active,
  roundsSent,
  expanded,
  canChangeTable,
  onToggle,
  onOpenBill,
  onOpenRounds,
}: {
  active: ActiveTableSession;
  roundsSent: number;
  expanded: boolean;
  canChangeTable: boolean;
  onToggle: () => void;
  onOpenBill: () => void;
  onOpenRounds: () => void;
}) {
  return (
    <Card>
      <CardContent className="flex flex-wrap items-center justify-between gap-3 p-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="rounded-md bg-brand-100 p-2 text-primary">
            <UtensilsCrossed className="h-4 w-4" aria-hidden />
          </span>
          <div className="min-w-0">
            {/* The table name alone (PO, 2026-08-21). A waiter says "table
                nine", never "session 12" — the session number is an internal
                document id and prefixing the one thing they recognise with it
                buries it. */}
            <p className="truncate text-sm font-semibold">{active.tableLabel}</p>
            <p className="truncate text-xs text-muted-foreground">
              Open {formatElapsed(active.openedAt)}
              {active.guestCount ? ` · ${active.guestCount} guests` : ''}
              {roundsSent > 0
                ? ` · ${roundsSent} round${roundsSent === 1 ? '' : 's'} sent`
                : ' · nothing sent yet'}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {canChangeTable ? (
            <Button
              size="sm"
              variant="ghost"
              aria-expanded={expanded}
              onClick={onToggle}
              leftIcon={
                <ChevronDown
                  className={`h-4 w-4 transition-transform ${expanded ? 'rotate-180' : ''}`}
                />
              }
            >
              Change table
            </Button>
          ) : null}
          {/* D150 — what is already on the table: every sent round, its kitchen
              status, and the void. The waiter arriving from the floor's "View
              order" came to read this, so it is the strip's primary action. */}
          <Button size="sm" variant="secondary" onClick={onOpenRounds}>
            Order so far
          </Button>
          {/* D71 — one door to the money: review the bill, split it, close it. */}
          <Button size="sm" variant="outline" onClick={onOpenBill}>
            Bill
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function Picker({
  session,
  branchId,
  activeId,
  onPick,
}: {
  session: Session;
  branchId: string;
  activeId: string | null;
  onPick: (picked: ActiveTableSession) => void;
}) {
  const [open, setOpen] = React.useState<OpenSessionRow[]>([]);
  const [areas, setAreas] = React.useState<DiningAreaView[]>([]);
  const [tablesByArea, setTablesByArea] = React.useState<Map<string, RestaurantTableView[]>>(
    new Map(),
  );
  /** D49/D50 — kept apart from `tablesByArea` because they belong to no area. */
  const [joined, setJoined] = React.useState<OpenTableView[]>([]);
  const [labels, setLabels] = React.useState<Map<string, string>>(new Map());
  const [loading, setLoading] = React.useState(true);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  /**
   * D104 — the arrangement whose seat prompt is up. Only groups get a prompt:
   * an ordinary free table still seats on one tap, because the fast path is
   * the commonest action in service and adding a dialog to it would cost every
   * waiter a tap on every cover to serve the rarer case.
   */
  const [seatTarget, setSeatTarget] = React.useState<OpenTableView | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  /**
   * Area filter — the floor plan's control, minus its "All areas" chip (PO,
   * 2026-08-21). Showing every area at once is what made this block tall in
   * the first place, and a waiter works one section of the room, so exactly
   * one area is selected at all times. `null` only ever means "areas have
   * not loaded yet".
   */
  const [selected, setSelected] = React.useState<string | null>(null);
  /**
   * D151 — whose running tables the strip lists. Null until a chip is tapped;
   * `resolveOwnerScope` then defaults it from the data, so a waiter lands on
   * their own tables and a cashier (who opens none) still sees the floor.
   */
  const [ownerChoice, setOwnerChoice] = React.useState<SessionOwnerScope | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      /*
       * D150 — the furniture and its label map come from the shared resolver,
       * which the floor plan's deep link reads too. The two used to be one
       * inline block here, and a deep-linked session would have had to
       * re-derive it (or settle for a session number on the strip).
       */
      const [sessions, furniture] = await Promise.all([
        tableSessions.listOpen(session, branchId).catch(() => [] as OpenSessionRow[]),
        loadBranchFurniture(session, branchId),
      ]);
      const sorted = furniture.areas;

      setOpen(sessions as OpenSessionRow[]);
      setAreas(sorted);
      setTablesByArea(furniture.tablesByArea);
      setJoined(furniture.joined);
      setLabels(furniture.labels);
      /*
       * With no "All" option there must always be a valid selection, so the
       * first area is chosen on load — and re-chosen if a refresh archived
       * the area that was selected. Without the second half the block would
       * silently show nothing at all, which looks exactly like a branch with
       * no tables.
       */
      setSelected((current) =>
        current === OPEN_VIEW || (current && sorted.some((a) => a.id === current))
          ? current
          : sorted[0]?.id ?? null,
      );
    } finally {
      setLoading(false);
    }
  }, [session, branchId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  /**
   * Open a tab. `extra` carries the answers the group prompt collected (D104);
   * an ordinary free table still seats on one tap with nothing to fill in.
   */
  const seat = async (
    table: RestaurantTableView,
    extra?: { guestCount?: number; tabName?: string },
  ) => {
    setBusyId(table.id);
    setError(null);
    try {
      /*
       * The waiter who seats the table is the one serving it, so record them
       * on the session. `waiterUserId` is optional and the server does NOT
       * default it to the caller — leaving it unset shows the kitchen a
       * ticket with no name on it, and the close path then has to fall back
       * to whoever happened to press the button.
       */
      const opened = await tableSessions.open(session, branchId, {
        tableId: table.id,
        waiterUserId: session.user.id,
        ...(extra?.guestCount != null ? { guestCount: extra.guestCount } : {}),
        ...(extra?.tabName ? { tabName: extra.tabName } : {}),
      });
      onPick({
        id: opened.id,
        sessionNumber: opened.sessionNumber,
        tableLabel: tabLabel(table.label ?? table.code, opened.tabName),
        openedAt: opened.openedAt,
        guestCount: opened.guestCount,
        orderId: null,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not open that table');
      // The table may have been seated by someone else a second ago; a
      // refresh is more useful here than a stale grid.
      await load();
    } finally {
      setBusyId(null);
    }
  };

  /*
   * D151 — whose running tables the strip lists. `mineOpen` is also what the
   * default reads: a waiter with tables of their own opens on those, and anyone
   * with none (a cashier at the till) opens on the floor rather than on an
   * empty strip that looks like a branch with no parties in it.
   */
  const mineOpen = React.useMemo(
    () => open.filter((s) => isMySession(s, session.user.id)),
    [open, session.user.id],
  );
  /*
   * D152b — mine unless the waiter said otherwise; the data never moves it.
   * D152c — a supervisor works the whole room: the strip opens on every
   * running table and carries no chips to narrow it.
   */
  const supervises = supervisesTheFloor(session.user.role);
  const ownerScope = resolveOwnerScope(ownerChoice ?? (supervises ? 'all' : null));
  const shownOpen = ownerScope === 'mine' ? mineOpen : open;

  /*
   * D92 — Open is a destination in the same strip, so it spans every floor:
   * a waiter carrying two tables in two rooms should not have to remember
   * which room to look in.
   */
  const showingOpen = selected === OPEN_VIEW;
  const visibleAreas = showingOpen ? areas : areas.filter((a) => a.id === selected);

  /**
   * D50 — which arrangements hold each physical table, the same derivation the
   * floor plan makes (`table-floor.tsx`). Used only to name the holder on a
   * RESERVED chip: "Reserved — another waiter's table" is the wrong story for a
   * table that was absorbed rather than served, and the waiter who cannot tap
   * M3 deserves to be told it is part of their own arrangement.
   */
  const heldByTableId = React.useMemo(() => {
    const map = new Map<string, OpenTableView[]>();
    for (const arrangement of joined) {
      for (const member of arrangement.members) {
        const list = map.get(member.id) ?? [];
        list.push(arrangement);
        map.set(member.id, list);
      }
    }
    return map;
  }, [joined]);

  /*
   * D91 — the open sessions this user is allowed to work, keyed by table.
   *
   * `open` is already scoped by the server (D70: a waiter sees only sessions
   * they opened; a supervisor sees the floor). So a table can be OCCUPIED and
   * absent from this map, and that is not a gap to paper over — it is
   * somebody else's table. It is shown, so the waiter can see the room, and
   * it is not clickable, because opening it is exactly what the server
   * refuses.
   *
   * D104 — a LIST per table, not a row. An arrangement can carry several of
   * this waiter's own tabs at once, and the `new Map(...)` this replaces was
   * last-wins: the earlier party simply vanished from the grid, which is the
   * worst failure available here because nothing about it looks wrong.
   */
  /*
   * D151 — keyed off the SHOWN set, not every session the server returned. With
   * "Mine" selected this is exactly the pre-D151 map (the scoped read), so an
   * occupied table that is somebody else's stays drawn-and-greyed; switching to
   * "All" is what makes it tappable. Reading `open` here instead would have let
   * the room grid ignore the chips the strip above it is obeying.
   */
  const shownSessionsByTable = React.useMemo(() => {
    const map = new Map<string, OpenSessionRow[]>();
    for (const s of shownOpen) {
      const list = map.get(s.tableId) ?? [];
      list.push(s);
      map.set(s.tableId, list);
    }
    return map;
  }, [shownOpen]);

  /** Resume a session the user already has — the strip and the grid share it. */
  const resume = React.useCallback(
    (s: OpenSessionRow) => onPick(activeSessionFrom(s, labels)),
    [labels, onPick],
  );

  /** Open tables under Open; everything else under its own floor. */
  const tablesIn = (areaId: string): RestaurantTableView[] =>
    (tablesByArea.get(areaId) ?? []).filter((t) =>
      showingOpen ? isOpenTable(t.status) : !isOpenTable(t.status),
    );

  /** Why a drawn table cannot be tapped — the reasons read differently. */
  const unavailableTitle = (t: RestaurantTableView): string => {
    const held = heldByTableId.get(t.id);
    if (held && held.length > 0) {
      const names = held.map((a) => a.label ?? a.code).join(', ');
      return `${TABLE_STATUS_LABELS[t.status]} — joined into ${names}`;
    }
    return `${TABLE_STATUS_LABELS[t.status]} — another waiter's table`;
  };

  /*
   * D104 — an arrangement is offered while it has chairs left, NOT while it is
   * AVAILABLE. Status is the wrong question for a shared table: it leaves
   * AVAILABLE the moment the first party sits, and the whole point is that a
   * second party may still join. An arrangement with no recorded seat count
   * (D49) is always offered — nobody stated a limit, so the server enforces
   * none and neither does this.
   */
  const arrangementSeatsFree = (t: OpenTableView): number | null => seatsFree(t);
  const arrangementIsFull = (t: OpenTableView): boolean => {
    const free = arrangementSeatsFree(t);
    return free !== null && free <= 0;
  };

  return (
    /*
     * D69 asked for a block that never takes more than half the screen, and
     * D91 broke the way that was expressed: the cap reserved a FIXED 11rem
     * for the block's own chrome, measured on a tablet, and the state chips
     * wrap to a second row on a narrow one — where the real chrome is 15.5rem.
     * The number was a guess that only held at one width.
     *
     * Capping the CARD and letting the grid take what is left states the
     * constraint exactly, at every width, with nothing to keep in step.
     */
    <Card>
      <CardContent className="flex max-h-[50dvh] flex-col gap-3 p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold">Which table?</p>
            <p className="text-xs text-muted-foreground">
              {/* D151 — "yours" was the whole truth before the floor became
                  readable (D70 scoped the read to the caller). It is now the
                  DEFAULT rather than the limit, so the copy says which view
                  the strip is starting from and where the rest is. */}
              Seat a free table from a floor, or pick Open to carry on with a
              running one. Open tables starts with yours — switch to All for the
              whole floor, where each table names the waiter serving it.
            </p>
          </div>
          <Button
            size="sm"
            variant="ghost"
            leftIcon={<RefreshCw className="h-3.5 w-3.5" />}
            onClick={() => void load()}
          >
            Refresh
          </Button>
        </div>

        {error ? <p className="text-sm text-danger">{error}</p> : null}

        {loading ? (
          <p className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading tables…
          </p>
        ) : (
          <>
            {/* Open sessions sit ABOVE the area filter and are never narrowed by
                it: this is the "carry on where I was" list, it is short, and
                hiding a running table behind a filter the waiter set for a
                different reason is how a party gets forgotten. D151 gives it
                the ONE filter it should have — whose tables — defaulted to the
                caller's own. */}
            {open.length > 0 ? (
              /* D91 — labelled as a group: the same table can appear here AND
                 in the room below (this strip crosses areas and ignores the
                 area filter), so "the T2 chip" is ambiguous without a name for
                 the section it is in. */
              <div role="group" aria-label="Open tables">
                <div className="mb-1.5 flex flex-wrap items-center gap-2">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Open tables
                  </p>
                  {/* Only when there is something to choose between: on a floor
                      where every running table is the caller's own, two chips
                      that filter nothing would be a control that lies. */}
                  {!supervises && mineOpen.length !== open.length ? (
                    <div className="flex flex-wrap gap-1.5">
                      <button
                        type="button"
                        data-active={ownerScope === 'mine'}
                        onClick={() => setOwnerChoice('mine')}
                        className={`inline-flex h-8 items-center rounded-full px-3 text-xs font-medium transition-colors ${
                          ownerScope === 'mine'
                            ? 'bg-primary text-primary-foreground'
                            : 'bg-muted text-foreground hover:bg-border'
                        }`}
                      >
                        Mine · {mineOpen.length}
                      </button>
                      <button
                        type="button"
                        data-active={ownerScope === 'all'}
                        onClick={() => setOwnerChoice('all')}
                        className={`inline-flex h-8 items-center rounded-full px-3 text-xs font-medium transition-colors ${
                          ownerScope === 'all'
                            ? 'bg-primary text-primary-foreground'
                            : 'bg-muted text-foreground hover:bg-border'
                        }`}
                      >
                        All · {open.length}
                      </button>
                    </div>
                  ) : null}
                </div>
                {/* D152b — the same "empty is a real state" line the queue
                    carries: under Mine with none of your own, the strip would
                    otherwise be a labelled blank next to a chip saying there
                    are sixteen. */}
                {shownOpen.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    None of the {open.length} running tables are yours — tap All to see them.
                  </p>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  {shownOpen.map((s) => {
                    const table = labels.get(s.tableId);
                    // D104 — two tabs on one arrangement are two chips here,
                    // and the tab's name is the only thing that tells them
                    // apart: the table name is identical on both.
                    const name = table ? tabLabel(table, s.tabName) : undefined;
                    // D151 — whose table, when it is not the caller's.
                    const owner = otherWaiterLabel(s, session.user.id);
                    return (
                      <button
                        key={s.id}
                        type="button"
                        data-active={s.id === activeId}
                        onClick={() => resume(s)}
                        className={`inline-flex h-11 items-center gap-2 rounded-lg border px-3 text-sm font-medium ${
                          s.id === activeId
                            ? 'border-primary bg-primary text-primary-foreground'
                            : 'border-primary/40 bg-brand-50 hover:border-primary'
                        }`}
                      >
                        {name ?? s.sessionNumber}
                        <span
                          className={`text-xs font-normal ${
                            s.id === activeId ? 'opacity-80' : 'text-muted-foreground'
                          }`}
                        >
                          {formatElapsed(s.openedAt)}
                          {s.guestCount ? ` · ${s.guestCount}` : ''}
                          {owner ? ` · ${owner}` : ''}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : null}

            {/* D92 — one strip, one selection: Open, then each floor. It sits
                first because "carry on with a table" is the commoner errand
                during service than "seat a new party", and because a strip
                that scrolls should not hide the destination most often
                wanted behind a swipe. */}
            {areas.length > 0 ? (
              <div className="flex items-center gap-3">
                <span className="shrink-0 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Show
                </span>
                <ChipRow
                  ariaLabel="Filter tables by dining area"
                  activeKey={selected ?? ''}
                  className="min-w-0 flex-1"
                >
                  <AreaChip
                    label="Open"
                    active={showingOpen}
                    onClick={() => setSelected(OPEN_VIEW)}
                  />
                  {areas.map((a) => (
                    <AreaChip
                      key={a.id}
                      label={a.name}
                      active={selected === a.id}
                      onClick={() => setSelected(a.id)}
                    />
                  ))}
                </ChipRow>
              </div>
            ) : null}

            {/* Takes whatever the capped card has left, and scrolls: a branch
                with five areas of nine tables would otherwise push the menu —
                the thing the waiter actually came here to use — off the
                bottom. `min-h` still wins over the flex basis, so a very
                short viewport degrades to a small scroller rather than to
                nothing at all. */}
            <div
              role="group"
              aria-label="Tables in this area"
              className="min-h-[7rem] flex-1 space-y-3 overflow-y-auto"
            >
              {areas.length === 0 ? (
                <p className="py-4 text-sm text-muted-foreground">
                  No dining areas configured yet. Add an area and its tables in Tables.
                </p>
              ) : showingOpen &&
                joined.length === 0 &&
                visibleAreas.every((a) => tablesIn(a.id).length === 0) ? (
                /* One message for the whole view rather than an empty heading
                   per floor: under Open, a branch with five quiet rooms would
                   otherwise print five identical "nothing here" lines. */
                <p className="py-4 text-sm text-muted-foreground">
                  No tables in service right now. Pick a floor to seat one.
                </p>
              ) : (
                <>
                  {/* D104 — the arrangements, first and above the floors.
                      They live under Open and nowhere else (they belong to no
                      area), and unlike a physical table they stay here once a
                      party sits down: an arrangement can be occupied AND still
                      have chairs for a second party, so status is the wrong
                      thing to file them by. */}
                  {showingOpen && joined.length > 0 ? (
                    <div>
                      <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        Open tables
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {joined.map((t) => {
                          const free = arrangementSeatsFree(t);
                          const full = arrangementIsFull(t);
                          const name = t.label ?? t.code;
                          const members = t.members.map((m) => m.code).join(' + ');
                          return (
                            <button
                              key={t.id}
                              type="button"
                              disabled={busyId !== null || full}
                              title={
                                full
                                  ? `${name} is full — all ${t.capacity} seats are taken.`
                                  : `Start a tab on ${name}`
                              }
                              onClick={() => setSeatTarget(t)}
                              className={`inline-flex h-11 items-center gap-2 rounded-lg border px-3 text-sm disabled:opacity-60 ${
                                full
                                  ? 'border-dashed border-border bg-muted text-muted-foreground'
                                  : 'border-border bg-card hover:border-primary'
                              }`}
                            >
                              {busyId === t.id ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                              ) : null}
                              {name}
                              <span className="inline-flex items-center gap-0.5 text-xs font-normal text-muted-foreground">
                                {members ? `${members} · ` : ''}
                                {/* Seats only when the operator recorded them
                                    (D49) — inventing "0 free" for an
                                    arrangement nobody sized would refuse
                                    nothing and confuse everyone. */}
                                {free === null
                                  ? `${t.liveTabs} tab${t.liveTabs === 1 ? '' : 's'}`
                                  : `${t.capacity} seats · ${t.seatsTaken} taken, ${free} free`}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ) : null}
                  {visibleAreas.map((area) => {
                  const all = tablesByArea.get(area.id) ?? [];
                  const shown = tablesIn(area.id);
                  // Under Open, a floor with nothing running is skipped
                  // entirely — its heading would be the only thing in it.
                  if (showingOpen && shown.length === 0) return null;
                  return (
                    <div key={area.id}>
                      <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        {area.name}
                      </p>
                      {shown.length === 0 ? (
                        <p className="text-xs text-muted-foreground">
                          {/* Which of the two questions came back empty. One
                              message for both would read as "this area has no
                              tables" while the area is full of seated ones. */}
                          {all.length === 0
                            ? 'No tables in this area yet. Add them in Tables.'
                            : 'Every table here is seated — they are under Open.'}
                        </p>
                      ) : (
                        <div className="flex flex-wrap gap-2">
                          {shown.map((t) => (
                            <TableChip
                              key={t.id}
                              table={t}
                              // A physical table still carries at most one of
                              // the waiter's tabs (D104 relaxed the rule for
                              // arrangements only), so the first is the only.
                              mine={shownSessionsByTable.get(t.id)?.[0]}
                              activeId={activeId}
                              busyId={busyId}
                              unavailableTitle={unavailableTitle(t)}
                              freeDetail={
                                t.capacity ? (
                                  <>
                                    <Users className="h-3 w-3" aria-hidden />
                                    {t.capacity}
                                  </>
                                ) : null
                              }
                              onResume={resume}
                              onSeat={seat}
                            />
                          ))}
                        </div>
                      )}
                    </div>
                  );
                  })}
                </>
              )}
            </div>
          </>
        )}
      </CardContent>
      {seatTarget ? (
        <SeatArrangementDialog
          table={seatTarget}
          busy={busyId === seatTarget.id}
          onClose={() => setSeatTarget(null)}
          onConfirm={async (guestCount, tabName) => {
            const target = seatTarget;
            setSeatTarget(null);
            await seat(target, { guestCount, tabName });
          }}
        />
      ) : null}
    </Card>
  );
}

/**
 * One tappable table, shared by the floor views and the joined view (D49/D50).
 *
 * Extracted rather than duplicated because a joined table must behave like any
 * other table on this screen — the ONE thing that differs is what its secondary
 * line says while it is free (`freeDetail`: seats on a physical table, member
 * codes on an arrangement). If seating a joined table ever drifted from seating
 * a physical one, it would drift here, silently.
 *
 * Three kinds of table, and the difference is what a tap does: seat a free one,
 * carry on with one of mine, and neither for anyone else's. The last is still
 * DRAWN — seeing that M4 is taken is the whole point of the PO's request (D91)
 * — but the server refuses to hand it over (D70), so offering the tap would be
 * offering a refusal.
 */
function TableChip({
  table,
  mine,
  activeId,
  busyId,
  unavailableTitle,
  freeDetail,
  onResume,
  onSeat,
}: {
  table: RestaurantTableView;
  mine: OpenSessionRow | undefined;
  activeId: string | null;
  busyId: string | null;
  unavailableTitle: string;
  freeDetail: React.ReactNode;
  onResume: (s: OpenSessionRow) => void;
  onSeat: (t: RestaurantTableView) => void;
}) {
  const isActive = mine ? mine.id === activeId : false;
  const free = table.status === 'AVAILABLE';
  const clickable = free || !!mine;
  return (
    <button
      type="button"
      disabled={busyId !== null || !clickable}
      aria-current={isActive ? 'true' : undefined}
      title={clickable ? undefined : unavailableTitle}
      onClick={() => {
        if (mine) onResume(mine);
        else if (free) void onSeat(table);
      }}
      className={`inline-flex h-11 items-center gap-2 rounded-lg border px-3 text-sm disabled:opacity-60 ${
        isActive
          ? 'border-primary bg-primary text-primary-foreground'
          : mine
            ? 'border-primary/40 bg-brand-50 hover:border-primary'
            : free
              ? 'border-border bg-card hover:border-primary'
              : 'border-dashed border-border bg-muted text-muted-foreground'
      }`}
    >
      {busyId === table.id ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
      ) : null}
      {table.label ?? table.code}
      <span
        className={`inline-flex items-center gap-0.5 text-xs font-normal ${
          isActive ? 'opacity-80' : 'text-muted-foreground'
        }`}
      >
        {mine ? (
          <>
            {formatElapsed(mine.openedAt)}
            {mine.guestCount ? ` · ${mine.guestCount}` : ''}
          </>
        ) : free ? (
          freeDetail
        ) : (
          TABLE_STATUS_LABELS[table.status]
        )}
      </span>
    </button>
  );
}

/**
 * D104 — the prompt that opens a tab on an arrangement.
 *
 * Two questions, and both exist because a group is shared. The guest count is
 * what the server subtracts from the seats, so without it the "4 taken, 2 free"
 * on the chip would be a number nobody maintains. The tab name is what the
 * kitchen ticket and the bill are headed with, and it is the only thing that
 * tells two parties on one arrangement apart — so it is required exactly when
 * a sibling tab already exists, and optional when this is the first.
 *
 * Physical tables get no dialog at all: they carry one party, so there is
 * nothing to disambiguate and the one-tap seat stays one tap.
 */
function SeatArrangementDialog({
  table,
  busy,
  onClose,
  onConfirm,
}: {
  table: OpenTableView;
  busy: boolean;
  onClose: () => void;
  onConfirm: (guestCount: number | undefined, tabName: string | undefined) => void;
}) {
  const free = seatsFree(table);
  const [guests, setGuests] = React.useState(free === null ? '2' : String(Math.min(2, free)));
  const [tabName, setTabName] = React.useState('');
  const name = table.label ?? table.code;
  // A sibling tab is already running, so this one must be nameable.
  const nameRequired = table.liveTabs > 0;
  const guestNum = Number(guests);
  const guestsValid =
    free === null
      ? guests === '' || (Number.isInteger(guestNum) && guestNum >= 1)
      : Number.isInteger(guestNum) && guestNum >= 1 && guestNum <= free;
  const valid = guestsValid && (!nameRequired || tabName.trim().length > 0);

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Start a tab on ${name}`}
      description={
        free === null
          ? `Seating as arranged — no seat count recorded. ${table.liveTabs} tab${table.liveTabs === 1 ? '' : 's'} running.`
          : `${table.capacity} seats, ${table.seatsTaken} taken — ${free} free.`
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={() =>
              onConfirm(
                guests === '' ? undefined : guestNum,
                tabName.trim() || undefined,
              )
            }
            isLoading={busy}
            disabled={!valid}
          >
            Open tab
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="space-y-1.5">
          <label className="text-sm font-medium" htmlFor="tab-guest-count">
            Guest count
          </label>
          <Input
            id="tab-guest-count"
            value={guests}
            onChange={(e) => setGuests(e.target.value)}
            inputMode="numeric"
            autoFocus
          />
          {guests && !guestsValid ? (
            <p className="text-xs text-danger">
              {free === null
                ? 'The number of guests being seated.'
                : `Between 1 and ${free} — the rest of this table is already taken.`}
            </p>
          ) : null}
        </div>
        <div className="space-y-1.5">
          <label className="text-sm font-medium" htmlFor="tab-name">
            Tab name{nameRequired ? '' : ' (optional)'}
          </label>
          <Input
            id="tab-name"
            value={tabName}
            onChange={(e) => setTabName(e.target.value)}
            placeholder="Who this tab is for"
          />
          <p className="text-xs text-muted-foreground">
            {nameRequired
              ? `Another party is already on ${name} — name this tab so the kitchen can tell them apart.`
              : 'Only needed once a second party shares this table.'}
          </p>
        </div>
      </div>
    </Dialog>
  );
}
