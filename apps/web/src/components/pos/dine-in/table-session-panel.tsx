'use client';

import { ChevronDown, Loader2, RefreshCw, Users, UtensilsCrossed } from 'lucide-react';
import * as React from 'react';

import { AreaChip } from '@/components/restaurant/area-chip';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ChipRow } from '@/components/ui/chip-row';
import { type Session } from '@/lib/auth';
import { diningAreas, restaurantTables, tableSessions } from '@/lib/restaurant/api';
import { TABLE_STATUS_LABELS, formatElapsed } from '@/lib/restaurant/labels';
import type {
  DiningAreaView,
  RestaurantTableStatus,
  RestaurantTableView,
} from '@/lib/restaurant/types';

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

interface Props {
  session: Session;
  branchId: string;
  active: ActiveTableSession | null;
  onPick: (picked: ActiveTableSession) => void;
  /** D71 — opens the bill sheet: full order, totals, split, close. */
  onOpenBill: () => void;
  /** Rounds already sent to the kitchen on this session, for the strip. */
  roundsSent: number;
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
  roundsSent,
}: Props) {
  const [expanded, setExpanded] = React.useState(false);

  // Choosing a table collapses the picker; losing the session (a close, or a
  // mode change) must not leave it collapsed with nothing to show.
  React.useEffect(() => {
    if (active) setExpanded(false);
  }, [active]);

  const showPicker = active === null || expanded;

  return (
    <div className="space-y-2">
      {active ? (
        <ActiveStrip
          active={active}
          roundsSent={roundsSent}
          expanded={expanded}
          onToggle={() => setExpanded((v) => !v)}
          onOpenBill={onOpenBill}
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
  onToggle,
  onOpenBill,
}: {
  active: ActiveTableSession;
  roundsSent: number;
  expanded: boolean;
  onToggle: () => void;
  onOpenBill: () => void;
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
          {/* D71 — one door to the money: review the bill, split it, close it. */}
          <Button size="sm" variant="outline" onClick={onOpenBill}>
            Bill
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

interface OpenSessionRow {
  id: string;
  sessionNumber: string;
  tableId: string;
  openedAt: string;
  guestCount: number | null;
  activeOrderId: string | null;
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
  const [labels, setLabels] = React.useState<Map<string, string>>(new Map());
  const [loading, setLoading] = React.useState(true);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  /**
   * Area filter — the floor plan's control, minus its "All areas" chip (PO,
   * 2026-08-21). Showing every area at once is what made this block tall in
   * the first place, and a waiter works one section of the room, so exactly
   * one area is selected at all times. `null` only ever means "areas have
   * not loaded yet".
   */
  const [selected, setSelected] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const [sessions, areaRows] = await Promise.all([
        tableSessions.listOpen(session, branchId).catch(() => [] as OpenSessionRow[]),
        diningAreas.list(session, branchId, false).catch(() => [] as DiningAreaView[]),
      ]);
      const sorted = areaRows.slice().sort((a, b) => a.position - b.position);
      const lists = await Promise.all(
        sorted.map((a) => restaurantTables.list(session, a.id, false).catch(() => [])),
      );

      /*
       * EVERY area is loaded regardless of the filter, and the label map is
       * built from every table in them. Two reasons, both of which produce a
       * silent wrong answer otherwise: a session in a filtered-out area would
       * lose its name entirely — leaving the waiter a chip labelled with a
       * bare session number and no way to tell which table it is. The filter
       * narrows what is DISPLAYED, never what is known.
       *
       * D91 — and every table is kept, not just the AVAILABLE ones. The
       * state filter below decides what is shown; discarding the rest here
       * would make "Open" a chip that can only ever be empty.
       */
      const labelMap = new Map<string, string>();
      const byArea = new Map<string, RestaurantTableView[]>();
      sorted.forEach((a, i) => {
        const rows = lists[i] ?? [];
        for (const t of rows) labelMap.set(t.id, t.label ?? t.code);
        byArea.set(a.id, rows);
      });

      setOpen(sessions as OpenSessionRow[]);
      setAreas(sorted);
      setTablesByArea(byArea);
      setLabels(labelMap);
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

  const seat = async (table: RestaurantTableView) => {
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
      });
      onPick({
        id: opened.id,
        sessionNumber: opened.sessionNumber,
        tableLabel: table.label ?? table.code,
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
   * D92 — Open is a destination in the same strip, so it spans every floor:
   * a waiter carrying two tables in two rooms should not have to remember
   * which room to look in.
   */
  const showingOpen = selected === OPEN_VIEW;
  const visibleAreas = showingOpen ? areas : areas.filter((a) => a.id === selected);

  /*
   * D91 — the open sessions this user is allowed to work, keyed by table.
   *
   * `open` is already scoped by the server (D70: a waiter sees only sessions
   * they opened; a supervisor sees the floor). So a table can be OCCUPIED and
   * absent from this map, and that is not a gap to paper over — it is
   * somebody else's table. It is shown, so the waiter can see the room, and
   * it is not clickable, because opening it is exactly what the server
   * refuses.
   */
  const mySessionByTable = React.useMemo(
    () => new Map(open.map((s) => [s.tableId, s])),
    [open],
  );

  /** Resume a session the user already has — the strip and the grid share it. */
  const resume = React.useCallback(
    (s: OpenSessionRow) =>
      onPick({
        id: s.id,
        sessionNumber: s.sessionNumber,
        tableLabel: labels.get(s.tableId) ?? s.sessionNumber,
        openedAt: s.openedAt,
        guestCount: s.guestCount,
        orderId: s.activeOrderId,
      }),
    [labels, onPick],
  );

  /** Open tables under Open; everything else under its own floor. */
  const tablesIn = (areaId: string): RestaurantTableView[] =>
    (tablesByArea.get(areaId) ?? []).filter((t) =>
      showingOpen ? isOpenTable(t.status) : !isOpenTable(t.status),
    );

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
              {/* D70 — "yours" is the honest word: the server only returns
                  sessions this user opened, unless they supervise the floor. */}
              Seat a free table from a floor, or pick Open to carry on with a
              running one. Tables another waiter is serving are shown, greyed.
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
            {/* Open sessions sit ABOVE the filter and are never filtered: this
                is the "carry on where I was" list, it is short, and hiding a
                running table behind a filter the waiter set for a different
                reason is how a party gets forgotten. */}
            {open.length > 0 ? (
              /* D91 — labelled as a group: the same table can appear here AND
                 in the room below (this strip crosses areas and ignores every
                 filter), so "the T2 chip" is ambiguous without a name for the
                 section it is in. */
              <div role="group" aria-label="Your open tables">
                <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Your open tables
                </p>
                <div className="flex flex-wrap gap-2">
                  {open.map((s) => {
                    const name = labels.get(s.tableId);
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
              ) : showingOpen && visibleAreas.every((a) => tablesIn(a.id).length === 0) ? (
                /* One message for the whole view rather than an empty heading
                   per floor: under Open, a branch with five quiet rooms would
                   otherwise print five identical "nothing here" lines. */
                <p className="py-4 text-sm text-muted-foreground">
                  No open tables right now. Pick a floor to seat one.
                </p>
              ) : (
                visibleAreas.map((area) => {
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
                          {shown.map((t) => {
                            const mine = mySessionByTable.get(t.id);
                            const isActive = mine ? mine.id === activeId : false;
                            const free = t.status === 'AVAILABLE';
                            /*
                             * Three kinds of table, and the difference is what
                             * a tap does: seat a free one, carry on with one of
                             * mine, and neither for anyone else's. The last is
                             * still DRAWN — seeing that M4 is taken is the
                             * whole point of the PO's request — but the server
                             * refuses to hand it over (D70), so offering the
                             * tap would be offering a refusal.
                             */
                            const clickable = free || !!mine;
                            return (
                              <button
                                key={t.id}
                                type="button"
                                disabled={busyId !== null || !clickable}
                                aria-current={isActive ? 'true' : undefined}
                                title={
                                  clickable
                                    ? undefined
                                    : `${TABLE_STATUS_LABELS[t.status]} — another waiter's table`
                                }
                                onClick={() => {
                                  if (mine) resume(mine);
                                  else if (free) void seat(t);
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
                                {busyId === t.id ? (
                                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                                ) : null}
                                {t.label ?? t.code}
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
                                    t.capacity ? (
                                      <>
                                        <Users className="h-3 w-3" aria-hidden />
                                        {t.capacity}
                                      </>
                                    ) : null
                                  ) : (
                                    TABLE_STATUS_LABELS[t.status]
                                  )}
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
