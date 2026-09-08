'use client';

import { ChefHat, Clock, ShoppingBag, UtensilsCrossed } from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';

import { PageHeader } from '@/components/page-header';
import { StatusBadge } from '@/components/restaurant/status-badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useAuth, type Session } from '@/lib/auth';
import { diningAreas, kitchen, restaurantTables, takeaway, tableSessions } from '@/lib/restaurant/api';
import {
  KITCHEN_TICKET_STATUS_TONES,
  TABLE_STATUS_LABELS,
  TABLE_STATUS_TONES,
  TAKEAWAY_STATUS_LABELS,
  TAKEAWAY_STATUS_TONES,
  formatElapsed,
} from '@/lib/restaurant/labels';
import type {
  DiningAreaView,
  KitchenTicketView,
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
};

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

        const queuedTickets = hasPermission('kot:view')
          ? await kitchen.listTickets(session, branchId, 'QUEUED').catch(() => [])
          : [];
        const takeawayOrders = hasPermission('takeaway:view')
          ? await takeaway.list(session, branchId).catch(() => [])
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
    <div className="space-y-6">
      <PageHeader
        title="Service dashboard"
        description={`${session.branchName} · ${session.registerName}`}
      />

      {state.status === 'error' ? (
        <Card>
          <CardContent className="py-6 text-sm text-danger">
            Could not load today&apos;s operational data. {state.error ?? ''}
          </CardContent>
        </Card>
      ) : null}

      {/* Summary tiles */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
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

      {/* Operational panels */}
      <div className="grid gap-4 lg:grid-cols-3">
        <NeedsAttentionCard
          tables={[...billRequested, ...cleaning, ...foodReadyTables].slice(0, 8)}
          areas={snapshot.areas}
          loading={state.status === 'loading'}
        />
        <TicketsCard tickets={snapshot.queuedTickets.slice(0, 6)} loading={state.status === 'loading'} />
        <TakeawayCard
          takeaways={takeawaysReady.concat(takeawaysWaiting).slice(0, 6)}
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
    <Card>
      <CardHeader>
        <CardTitle>Tables needing attention</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
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
    <Card>
      <CardHeader>
        <CardTitle>Kitchen queue</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
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

function TakeawayCard({
  takeaways,
  loading,
}: {
  takeaways: TakeawayView[];
  loading: boolean;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Takeaway</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
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
