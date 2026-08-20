'use client';

import { ChevronDown, Loader2, RefreshCw, Users, UtensilsCrossed } from 'lucide-react';
import * as React from 'react';

import { AreaChip } from '@/components/restaurant/area-chip';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ChipRow } from '@/components/ui/chip-row';
import { type Session } from '@/lib/auth';
import { diningAreas, restaurantTables, tableSessions } from '@/lib/restaurant/api';
import { formatElapsed } from '@/lib/restaurant/labels';
import type { DiningAreaView, RestaurantTableView } from '@/lib/restaurant/types';

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
  onCloseSession: () => void;
  /** Set while a close is in flight, so the strip cannot be double-fired. */
  closing: boolean;
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
  onCloseSession,
  closing,
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
          closing={closing}
          expanded={expanded}
          onToggle={() => setExpanded((v) => !v)}
          onCloseSession={onCloseSession}
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
  closing,
  expanded,
  onToggle,
  onCloseSession,
}: {
  active: ActiveTableSession;
  roundsSent: number;
  closing: boolean;
  expanded: boolean;
  onToggle: () => void;
  onCloseSession: () => void;
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
          <Button size="sm" variant="outline" isLoading={closing} onClick={onCloseSession}>
            Close session &amp; bill
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
  const [selectedArea, setSelectedArea] = React.useState<string | null>(null);

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
       * silent wrong answer otherwise: an open session's table is occupied
       * (so it is absent from the available lists), and a session in a
       * filtered-out area would lose its name entirely — leaving the waiter
       * a chip labelled with a bare session number and no way to tell which
       * table it is. The filter narrows what is DISPLAYED, never what is
       * known.
       */
      const labelMap = new Map<string, string>();
      const availableByArea = new Map<string, RestaurantTableView[]>();
      sorted.forEach((a, i) => {
        const rows = lists[i] ?? [];
        for (const t of rows) labelMap.set(t.id, t.label ?? t.code);
        availableByArea.set(
          a.id,
          rows.filter((t) => t.status === 'AVAILABLE'),
        );
      });

      setOpen(sessions as OpenSessionRow[]);
      setAreas(sorted);
      setTablesByArea(availableByArea);
      setLabels(labelMap);
      /*
       * With no "All" option there must always be a valid selection, so the
       * first area is chosen on load — and re-chosen if a refresh archived
       * the area that was selected. Without the second half the block would
       * silently show nothing at all, which looks exactly like a branch with
       * no tables.
       */
      setSelectedArea((current) =>
        current && sorted.some((a) => a.id === current) ? current : sorted[0]?.id ?? null,
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

  const visibleAreas = areas.filter((a) => a.id === selectedArea);

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold">Which table?</p>
            <p className="text-xs text-muted-foreground">
              {/* D70 — "yours" is the honest word: the server only returns
                  sessions this user opened, unless they supervise the floor. */}
              Seat a table to start a session, or carry on with one of yours.
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
              <div>
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
                        onClick={() =>
                          onPick({
                            id: s.id,
                            sessionNumber: s.sessionNumber,
                            tableLabel: name ?? s.sessionNumber,
                            openedAt: s.openedAt,
                            guestCount: s.guestCount,
                            orderId: s.activeOrderId,
                          })
                        }
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

            {areas.length > 1 ? (
              <div className="flex items-center gap-3">
                <span className="shrink-0 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Show
                </span>
                <ChipRow
                  ariaLabel="Filter tables by dining area"
                  activeKey={selectedArea ?? ''}
                  className="min-w-0 flex-1"
                >
                  {areas.map((a) => (
                    <AreaChip
                      key={a.id}
                      label={a.name}
                      active={selectedArea === a.id}
                      onClick={() => setSelectedArea(a.id)}
                    />
                  ))}
                </ChipRow>
              </div>
            ) : null}

            {/* Capped and scrollable: a branch with five areas of nine tables
                would otherwise push the menu — the thing the waiter actually
                came here to use — off the bottom of a tablet.
                The cap is expressed against the block's own chrome (header +
                open sessions + filter ≈ 11rem) so the WHOLE card stays under
                half the viewport, which is the constraint that was asked
                for; `min-h` wins over `max-h` in CSS, so a short viewport
                degrades to a small scroller rather than to nothing. */}
            <div className="max-h-[calc(50vh-11rem)] min-h-[7rem] space-y-3 overflow-y-auto">
              {areas.length === 0 ? (
                <p className="py-4 text-sm text-muted-foreground">
                  No dining areas configured yet. Add an area and its tables in Tables.
                </p>
              ) : (
                visibleAreas.map((area) => {
                  const free = tablesByArea.get(area.id) ?? [];
                  return (
                    <div key={area.id}>
                      <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        {area.name}
                      </p>
                      {free.length === 0 ? (
                        <p className="text-xs text-muted-foreground">
                          Every table here is seated.
                        </p>
                      ) : (
                        <div className="flex flex-wrap gap-2">
                          {free.map((t) => (
                            <button
                              key={t.id}
                              type="button"
                              disabled={busyId !== null}
                              onClick={() => void seat(t)}
                              className="inline-flex h-11 items-center gap-2 rounded-lg border border-border bg-card px-3 text-sm hover:border-primary disabled:opacity-50"
                            >
                              {busyId === t.id ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                              ) : null}
                              {t.label ?? t.code}
                              {t.capacity ? (
                                <span className="inline-flex items-center gap-0.5 text-xs text-muted-foreground">
                                  <Users className="h-3 w-3" aria-hidden />
                                  {t.capacity}
                                </span>
                              ) : null}
                            </button>
                          ))}
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
