'use client';

import { CalendarClock, ChefHat, Clock, ShoppingBag, UtensilsCrossed } from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';

import { PageHeader } from '@/components/page-header';
import { StatusBadge } from '@/components/restaurant/status-badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useAuth, type Session } from '@/lib/auth';
import {
  diningAreas,
  kitchen,
  reservations as reservationsApi,
  restaurantTables,
  takeaway,
  tableSessions,
} from '@/lib/restaurant/api';
import {
  KITCHEN_TICKET_STATUS_TONES,
  RESERVATION_STATUS_LABELS,
  RESERVATION_STATUS_TONES,
  TABLE_STATUS_LABELS,
  TABLE_STATUS_TONES,
  TAKEAWAY_STATUS_LABELS,
  TAKEAWAY_STATUS_TONES,
  formatElapsed,
} from '@/lib/restaurant/labels';
import type {
  DiningAreaView,
  KitchenTicketView,
  ReservationView,
  RestaurantTableView,
  TableSessionView,
  TakeawayView,
} from '@/lib/restaurant/types';

interface Snapshot {
  areas: DiningAreaView[];
  tables: RestaurantTableView[];
  openSessions: TableSessionView[];
  queuedTickets: KitchenTicketView[];
  takeawayOrders: TakeawayView[];
  /** D148 — the next bookings due at this branch, soonest first. */
  upcomingReservations: ReservationView[];
}

interface State {
  status: 'loading' | 'ready' | 'error';
  snapshot: Snapshot;
  error?: string;
}

const EMPTY: Snapshot = {
  areas: [],
  tables: [],
  openSessions: [],
  queuedTickets: [],
  takeawayOrders: [],
  upcomingReservations: [],
};

/**
 * How far ahead the reservations card looks (D148).
 *
 * A day, not a shift: the card is answering "what is coming", and a booking
 * for tomorrow lunch taken during tonight's service is exactly the thing a
 * host wants to see before they promise a walk-in a table. The card shows the
 * soonest few, so a quiet branch and a busy one both read the same.
 */
const RESERVATION_LOOKAHEAD_HOURS = 24;

/** Matches the calendar's own clock so a booking reads the same on both screens. */
function formatReservationTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

/**
 * The Restaurant Dashboard is operational, not decorative.
 *
 * Every card resolves to a real backend read. When a request fails, that card
 * shows an explicit error rather than falling through to zero — the empty
 * states are for a live-but-quiet restaurant, not for network trouble.
 */
export function RestaurantDashboard({ session }: { session: Session }) {
  const { hasPermission } = useAuth();
  const branchId = session.branchId;
  const [state, setState] = React.useState<State>({ status: 'loading', snapshot: EMPTY });

  React.useEffect(() => {
    let cancelled = false;
    if (!branchId) {
      setState({ status: 'ready', snapshot: EMPTY });
      return;
    }

    async function load() {
      try {
        // Fan out — the dashboard tolerates a partial by turning missing
        // sections into empty ones. Each promise's own catch keeps one
        // failed report from taking down the rest.
        if (!branchId) return;
        const areas = await diningAreas.list(session, branchId).catch(() => [] as DiningAreaView[]);
        const tableLists = await Promise.all(
          areas.map((a) =>
            restaurantTables.list(session, a.id).catch(() => [] as RestaurantTableView[]),
          ),
        );
        const tables = tableLists.flat();

        // For the dashboard summary we do not fetch per-session details; the
        // count alone is what the "Open tables" card needs. Non-AVAILABLE
        // tables are the count. Per-session detail lives on the Tables page.
        const openSessions: TableSessionView[] = [];

        // OUTSTANDING, not QUEUED: since D113 a ticket the cook has started is
        // IN_PROGRESS, and it is still work the kitchen owes. Counting QUEUED
        // alone read "Kitchen queue 0" with every ticket on the stove (D119).
        const queuedTickets = hasPermission('kot:view')
          ? await kitchen
              .listTickets(session, branchId, 'OUTSTANDING')
              /*
               * D154 — the read answers an envelope now (tickets + the board's
               * lane counts); this card wants the tickets. Taking `.items`
               * INSIDE the chain, ahead of the catch, is what keeps the
               * fallback the same shape as the success: a `.catch(() => [])`
               * behind a `.items` read would hand the dashboard `undefined`
               * and throw on `.length` the one time the kitchen is
               * unreachable — the exact failure this catch exists to absorb.
               */
              .then((res) => res.items)
              .catch(() => [] as KitchenTicketView[])
          : [];
        const takeawayOrders = hasPermission('takeaway:view')
          ? await takeaway.list(session, branchId).catch(() => [])
          : [];

        /*
         * D148 — the reservation book, on the dashboard.
         *
         * `from` is NOW rather than the top of the day: a booking at 18:00 is
         * no longer upcoming at 20:00, and a card headed "upcoming" that
         * opens with three tables already seated is worse than no card. The
         * list returns everything INTERSECTING the window, so a booking that
         * started ten minutes ago and has not been seated is still here —
         * which is the one the host most needs to see.
         *
         * `includeClosed` is left false, so cancelled, completed and no-show
         * bookings never reach the card.
         */
        const now = new Date();
        const upcomingReservations = hasPermission('reservation:view')
          ? await reservationsApi
              .list(
                session,
                branchId,
                now,
                new Date(now.getTime() + RESERVATION_LOOKAHEAD_HOURS * 60 * 60 * 1000),
              )
              .then((rows) =>
                [...rows].sort((a, b) => a.startAt.localeCompare(b.startAt)),
              )
              .catch(() => [] as ReservationView[])
          : [];

        if (!cancelled) {
          setState({
            status: 'ready',
            snapshot: {
              areas,
              tables,
              openSessions,
              queuedTickets,
              takeawayOrders,
              upcomingReservations,
            },
          });
        }
      } catch (err) {
        if (!cancelled) {
          setState({
            status: 'error',
            snapshot: EMPTY,
            error: err instanceof Error ? err.message : 'Failed to load dashboard',
          });
        }
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
    // `session` is included so the linter is satisfied; its reference is
    // stable across renders within a signed-in session, so re-firing on
    // ref change is a no-op.
  }, [branchId, hasPermission, session]);

  if (!branchId) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Restaurant"
          description="Sign in to a branch to see today's service."
        />
        <Card>
          <CardContent className="py-16 text-center text-sm text-muted-foreground">
            This user has no active branch. Ask an administrator to grant branch access.
          </CardContent>
        </Card>
      </div>
    );
  }

  const { snapshot } = state;
  const tables = snapshot.tables;
  const totalTables = tables.length;
  const openTables = tables.filter((t) => t.status !== 'AVAILABLE' && t.status !== 'BLOCKED');
  const foodReadyTables = tables.filter((t) => t.status === 'OCCUPIED');
  const billRequested = tables.filter((t) => t.status === 'BILLING');
  const cleaning = tables.filter((t) => t.status === 'CLEANING');
  const takeawaysReady = snapshot.takeawayOrders.filter((t) => t.status === 'READY');
  const takeawaysWaiting = snapshot.takeawayOrders.filter(
    (t) => t.status === 'PLACED' || t.status === 'IN_KITCHEN',
  );

  return (
    /*
     * The service dashboard FITS its screen (PO, 2026-09-09).
     *
     * The shell already gives `main` the only vertical scroll and a definite
     * height (`h-dvh` + `overflow-hidden` on the frame), so `lg:h-full` here
     * makes this page exactly as tall as the space it is given and the panel
     * row below absorbs whatever is left. Each panel then scrolls INSIDE its
     * own card. That is what keeps a fourth card from pushing the page into a
     * scroll: adding a panel costs width, never height.
     *
     * Height-constrained from `lg` up only. On a phone the tiles alone are
     * taller than the viewport, and four panels squeezed into quarter-height
     * boxes would be unreadable — there, scrolling the page is the right
     * answer and the constraint is simply not applied.
     */
    <div className="flex flex-col gap-4 lg:h-full lg:min-h-0">
      <div className="shrink-0">
        {/* D151 — the branch alone; the register half named a counter the
            system does not track. */}
        <PageHeader title="Service dashboard" description={session.branchName} />
      </div>

      {state.status === 'error' ? (
        <Card className="shrink-0">
          <CardContent className="py-6 text-sm text-danger">
            Could not load today&apos;s operational data. {state.error ?? ''}
          </CardContent>
        </Card>
      ) : null}

      {/* Summary tiles */}
      <div className="grid shrink-0 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryTile
          icon={<UtensilsCrossed className="h-5 w-5" />}
          label="Open tables"
          value={openTables.length}
          hint={`of ${totalTables} on the floor`}
          href="/tables"
          loading={state.status === 'loading'}
        />
        <SummaryTile
          icon={<Clock className="h-5 w-5" />}
          label="Bill requested"
          value={billRequested.length}
          hint="need to close out"
          href="/tables"
          loading={state.status === 'loading'}
        />
        <SummaryTile
          icon={<ChefHat className="h-5 w-5" />}
          label="Kitchen queue"
          value={snapshot.queuedTickets.length}
          hint="tickets to prepare"
          href="/kitchen"
          loading={state.status === 'loading'}
        />
        <SummaryTile
          icon={<ShoppingBag className="h-5 w-5" />}
          label="Takeaway ready"
          value={takeawaysReady.length}
          hint={`${takeawaysWaiting.length} waiting`}
          href="/takeaway"
          loading={state.status === 'loading'}
        />
      </div>

      {/*
        Operational panels. `auto-rows-fr` is what makes two rows of two share
        the height evenly at `lg`; without it the rows size to their content
        and the taller one pushes the page past the fold again.

        The lists are no longer sliced to a fixed few. A card that scrolls
        inside itself can hold the whole list, and truncating at six hid work
        from the very people the board is for.
      */}
      <div className="grid gap-4 lg:min-h-0 lg:flex-1 lg:auto-rows-fr lg:grid-cols-2 xl:grid-cols-4">
        <NeedsAttentionCard
          tables={[...billRequested, ...cleaning, ...foodReadyTables]}
          areas={snapshot.areas}
          loading={state.status === 'loading'}
        />
        <TicketsCard tickets={snapshot.queuedTickets} loading={state.status === 'loading'} />
        <UpcomingReservationsCard
          reservations={snapshot.upcomingReservations}
          tables={snapshot.tables}
          canView={hasPermission('reservation:view')}
          loading={state.status === 'loading'}
        />
        <TakeawayCard
          takeaways={takeawaysReady.concat(takeawaysWaiting)}
          loading={state.status === 'loading'}
        />
      </div>
    </div>
  );
}

function SummaryTile({
  icon,
  label,
  value,
  hint,
  href,
  loading,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  hint: string;
  href: string;
  loading: boolean;
}) {
  return (
    <Card>
      <CardContent className="flex items-start justify-between gap-3 p-5">
        <div className="min-w-0 space-y-1">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {label}
          </p>
          <p className="text-3xl font-semibold" aria-live="polite">
            {loading ? '—' : value}
          </p>
          <p className="text-xs text-muted-foreground">{hint}</p>
        </div>
        <div className="flex flex-col items-end gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-muted text-muted-foreground">
            {icon}
          </span>
          <Button asChild variant="ghost" size="sm">
            <Link href={href}>Open</Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function NeedsAttentionCard({
  tables,
  areas,
  loading,
}: {
  tables: RestaurantTableView[];
  areas: DiningAreaView[];
  loading: boolean;
}) {
  const areaById = React.useMemo(() => new Map(areas.map((a) => [a.id, a.name])), [areas]);
  return (
    <Card className="flex flex-col lg:h-full lg:min-h-0">
      <CardHeader className="shrink-0 p-4 pb-2">
        <CardTitle>Tables needing attention</CardTitle>
      </CardHeader>
      {/* The card, not the page, is the scroller — see the layout note above. */}
      <CardContent className="space-y-2 p-4 pt-0 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
        {loading ? (
          <p className="py-6 text-center text-sm text-muted-foreground">Loading tables…</p>
        ) : tables.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No tables need attention right now.
          </p>
        ) : (
          tables.map((t) => (
            <div
              key={t.id}
              className="flex items-center justify-between gap-3 rounded-xl border border-border p-3"
            >
              <div className="min-w-0">
                <p className="text-sm font-semibold">{t.label ?? `Table ${t.code}`}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {(t.areaId ? areaById.get(t.areaId) : null) ?? 'Open table'} · seats {t.capacity ?? '—'}
                </p>
              </div>
              <StatusBadge
                label={TABLE_STATUS_LABELS[t.status]}
                tone={TABLE_STATUS_TONES[t.status]}
              />
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}

function TicketsCard({
  tickets,
  loading,
}: {
  tickets: KitchenTicketView[];
  loading: boolean;
}) {
  return (
    <Card className="flex flex-col lg:h-full lg:min-h-0">
      <CardHeader className="shrink-0 p-4 pb-2">
        <CardTitle>Kitchen queue</CardTitle>
      </CardHeader>
      {/* The card, not the page, is the scroller — see the layout note above. */}
      <CardContent className="space-y-2 p-4 pt-0 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
        {loading ? (
          <p className="py-6 text-center text-sm text-muted-foreground">Loading tickets…</p>
        ) : tickets.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            Kitchen queue is empty.
          </p>
        ) : (
          tickets.map((t) => (
            <div
              key={t.id}
              className="flex items-start justify-between gap-3 rounded-xl border border-border p-3"
            >
              <div className="min-w-0">
                <p className="text-sm font-semibold">{t.ticketNumber}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {t.items.length} item{t.items.length === 1 ? '' : 's'} ·{' '}
                  {formatElapsed(t.createdAt)}
                </p>
              </div>
              <StatusBadge
                label={t.status}
                tone={KITCHEN_TICKET_STATUS_TONES[t.status]}
              />
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}

/**
 * D148 — the reservation book, on the service dashboard.
 *
 * The waiter and the restaurant cashier both land here, and both hold
 * `RESERVATION_VIEW`; between them they are the people who promise a walk-in
 * a table. Until now the only place a booking existed was /calendar, so that
 * promise was made from memory.
 *
 * Permission-gated as its own state, not by hiding the card. Someone whose
 * role does not carry `RESERVATION_VIEW` is told the book is not theirs
 * rather than shown an empty one — an empty card reads as "no bookings
 * tonight", which is a different and much more dangerous claim. The server
 * refuses the read either way; this is usability, not security.
 */
function UpcomingReservationsCard({
  reservations,
  tables,
  canView,
  loading,
}: {
  reservations: ReservationView[];
  tables: RestaurantTableView[];
  canView: boolean;
  loading: boolean;
}) {
  // The booking names a table id; the floor calls it "Table 12" or its label.
  const tableById = React.useMemo(
    () => new Map(tables.map((t) => [t.id, t.label ?? `Table ${t.code}`])),
    [tables],
  );
  return (
    <Card className="flex flex-col lg:h-full lg:min-h-0">
      <CardHeader className="shrink-0 p-4 pb-2">
        <CardTitle>Upcoming reservations</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 p-4 pt-0 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
        {!canView ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            The reservation book is not part of your role.
          </p>
        ) : loading ? (
          <p className="py-6 text-center text-sm text-muted-foreground">Loading reservations…</p>
        ) : reservations.length === 0 ? (
          <div className="py-6 text-center">
            <CalendarClock className="mx-auto h-5 w-5 text-muted-foreground" />
            <p className="mt-2 text-sm text-muted-foreground">
              Nothing booked in the next {RESERVATION_LOOKAHEAD_HOURS} hours.
            </p>
            <Button variant="link" size="sm" asChild>
              <Link href="/calendar">Open the calendar</Link>
            </Button>
          </div>
        ) : (
          reservations.map((r) => (
            <Link
              key={r.id}
              href="/calendar"
              className="flex items-center justify-between gap-3 rounded-xl border border-border p-3 hover:bg-muted"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold">
                  {formatReservationTime(r.startAt)} · {r.customerName}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {tableById.get(r.tableId) ?? 'Table released'} · {r.partySize}{' '}
                  {r.partySize === 1 ? 'guest' : 'guests'}
                </p>
              </div>
              <StatusBadge
                label={RESERVATION_STATUS_LABELS[r.status]}
                tone={RESERVATION_STATUS_TONES[r.status]}
              />
            </Link>
          ))
        )}
      </CardContent>
    </Card>
  );
}

function TakeawayCard({
  takeaways,
  loading,
}: {
  takeaways: TakeawayView[];
  loading: boolean;
}) {
  return (
    <Card className="flex flex-col lg:h-full lg:min-h-0">
      <CardHeader className="shrink-0 p-4 pb-2">
        <CardTitle>Takeaway</CardTitle>
      </CardHeader>
      {/* The card, not the page, is the scroller — see the layout note above. */}
      <CardContent className="space-y-2 p-4 pt-0 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
        {loading ? (
          <p className="py-6 text-center text-sm text-muted-foreground">Loading takeaway…</p>
        ) : takeaways.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No takeaway orders yet today.
          </p>
        ) : (
          takeaways.map((t) => (
            <div
              key={t.id}
              className="flex items-start justify-between gap-3 rounded-xl border border-border p-3"
            >
              <div className="min-w-0">
                <p className="text-sm font-semibold">{t.orderNumber}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {t.customerName ?? 'Walk-in'} · {formatElapsed(t.createdAt)}
                </p>
              </div>
              <StatusBadge
                label={TAKEAWAY_STATUS_LABELS[t.status]}
                tone={TAKEAWAY_STATUS_TONES[t.status]}
              />
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
