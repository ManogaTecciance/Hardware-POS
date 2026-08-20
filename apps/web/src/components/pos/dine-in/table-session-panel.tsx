'use client';

import { Loader2, RefreshCw, Users, UtensilsCrossed } from 'lucide-react';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
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
 * The one thing table service needs that a counter order does not: the
 * order belongs to a TABLE, over a period, across several rounds. So before
 * a waiter can compose anything they answer "which table", and afterwards
 * they answer "are they finished" — and between those two the screen is the
 * ordinary POS.
 *
 * Two states, deliberately not two screens: picking a table replaces this
 * block with a one-line strip rather than navigating, so the menu below it
 * never unmounts and a waiter mid-order does not lose their place.
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
  if (active) {
    return (
      <ActiveStrip
        active={active}
        roundsSent={roundsSent}
        closing={closing}
        onCloseSession={onCloseSession}
      />
    );
  }
  return <Picker session={session} branchId={branchId} onPick={onPick} />;
}

function ActiveStrip({
  active,
  roundsSent,
  closing,
  onCloseSession,
}: {
  active: ActiveTableSession;
  roundsSent: number;
  closing: boolean;
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
            <p className="truncate text-sm font-semibold">
              {active.tableLabel}
              <span className="ml-2 font-normal text-muted-foreground">
                Session {active.sessionNumber}
              </span>
            </p>
            <p className="truncate text-xs text-muted-foreground">
              Open {formatElapsed(active.openedAt)}
              {active.guestCount ? ` · ${active.guestCount} guests` : ''}
              {roundsSent > 0
                ? ` · ${roundsSent} round${roundsSent === 1 ? '' : 's'} sent`
                : ' · nothing sent yet'}
            </p>
          </div>
        </div>
        <Button size="sm" variant="outline" isLoading={closing} onClick={onCloseSession}>
          Close session &amp; bill
        </Button>
      </CardContent>
    </Card>
  );
}

function Picker({
  session,
  branchId,
  onPick,
}: {
  session: Session;
  branchId: string;
  onPick: (picked: ActiveTableSession) => void;
}) {
  const [open, setOpen] = React.useState<
    { id: string; sessionNumber: string; tableId: string; openedAt: string; guestCount: number | null; activeOrderId: string | null }[]
  >([]);
  const [areas, setAreas] = React.useState<DiningAreaView[]>([]);
  const [tablesByArea, setTablesByArea] = React.useState<Map<string, RestaurantTableView[]>>(
    new Map(),
  );
  const [labels, setLabels] = React.useState<Map<string, string>>(new Map());
  const [loading, setLoading] = React.useState(true);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const [sessions, areaRows] = await Promise.all([
        tableSessions.listOpen(session, branchId).catch(() => []),
        diningAreas.list(session, branchId, false).catch(() => [] as DiningAreaView[]),
      ]);
      const sorted = areaRows.slice().sort((a, b) => a.position - b.position);
      const lists = await Promise.all(
        sorted.map((a) => restaurantTables.list(session, a.id, false).catch(() => [])),
      );

      /*
       * One label map over EVERY table, not just the available ones: an open
       * session points at a table that is by definition occupied, so building
       * the map from the available list would leave every running session
       * labelled by a raw id.
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

      setOpen(sessions);
      setAreas(sorted);
      setTablesByArea(availableByArea);
      setLabels(labelMap);
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

  return (
    <Card>
      <CardContent className="space-y-4 p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold">Which table?</p>
            <p className="text-xs text-muted-foreground">
              Seat a table to start a session, or carry on with one that is already open.
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
            {open.length > 0 ? (
              <div>
                <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Open sessions
                </p>
                <div className="flex flex-wrap gap-2">
                  {open.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() =>
                        onPick({
                          id: s.id,
                          sessionNumber: s.sessionNumber,
                          tableLabel: labels.get(s.tableId) ?? `Session ${s.sessionNumber}`,
                          openedAt: s.openedAt,
                          guestCount: s.guestCount,
                          orderId: s.activeOrderId,
                        })
                      }
                      className="inline-flex h-11 items-center gap-2 rounded-lg border border-primary/40 bg-brand-50 px-3 text-sm font-medium hover:border-primary"
                    >
                      {labels.get(s.tableId) ?? `Session ${s.sessionNumber}`}
                      <span className="text-xs font-normal text-muted-foreground">
                        {formatElapsed(s.openedAt)}
                        {s.guestCount ? ` · ${s.guestCount}` : ''}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            {areas.length === 0 ? (
              <p className="py-4 text-sm text-muted-foreground">
                No dining areas configured yet. Add an area and its tables in Tables.
              </p>
            ) : (
              areas.map((area) => {
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
          </>
        )}
      </CardContent>
    </Card>
  );
}
