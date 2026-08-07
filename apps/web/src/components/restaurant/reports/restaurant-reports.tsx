'use client';

import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { type Session } from '@/lib/auth';
import { restaurantReports } from '@/lib/restaurant/api';
import { CHANNEL_LABELS, formatMoney, formatTime } from '@/lib/restaurant/labels';
import type {
  ChannelBreakdownRow,
  PaymentBreakdownRow,
  RestaurantOrderChannel,
  SalesSummaryView,
  TopMenuItemView,
  VoidReportRow,
  WaiterPerformanceRow,
} from '@/lib/restaurant/types';

interface Props {
  session: Session;
  branchId: string;
}

/** ISO date-input value → ISO timestamp (start-of-day) that the API accepts. */
function toStartOfDayIso(d: string): string {
  return new Date(`${d}T00:00:00`).toISOString();
}
function toEndOfDayIso(d: string): string {
  return new Date(`${d}T23:59:59.999`).toISOString();
}

/**
 * Reports dashboard for the current branch.
 *
 * Six reports the operator uses to close out the day: sales summary, top
 * items, waiter performance, payment mix, voids and channel breakdown. Every
 * card loads on its own so a slow one does not block the rest.
 */
export function RestaurantReports({ session, branchId }: Props) {
  const today = new Date().toISOString().slice(0, 10);
  const [from, setFrom] = React.useState(today);
  const [to, setTo] = React.useState(today);

  const range = React.useMemo(
    () => ({ from: toStartOfDayIso(from), to: toEndOfDayIso(to) }),
    [from, to],
  );

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Range</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end gap-3">
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="rep-from">
              From
            </label>
            <Input
              id="rep-from"
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="rep-to">
              To
            </label>
            <Input id="rep-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setFrom(today);
                setTo(today);
              }}
            >
              Today
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                const d = new Date();
                d.setDate(d.getDate() - 6);
                setFrom(d.toISOString().slice(0, 10));
                setTo(today);
              }}
            >
              Last 7 days
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                const first = new Date();
                first.setDate(1);
                setFrom(first.toISOString().slice(0, 10));
                setTo(today);
              }}
            >
              This month
            </Button>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <SalesSummaryCard session={session} branchId={branchId} range={range} />
        <PaymentBreakdownCard session={session} branchId={branchId} range={range} />
        <TopItemsCard session={session} branchId={branchId} range={range} />
        <WaiterPerformanceCard session={session} branchId={branchId} range={range} />
        <ChannelBreakdownCard session={session} branchId={branchId} range={range} />
        <VoidsCard session={session} branchId={branchId} range={range} />
      </div>
    </div>
  );
}

// ── Individual report cards ────────────────────────────────────────────────

function useReport<T>(
  key: unknown,
  fetcher: () => Promise<T>,
): { data: T | null; error: string | null; loading: boolean } {
  const [state, setState] = React.useState<{
    data: T | null;
    error: string | null;
    loading: boolean;
  }>({ data: null, error: null, loading: true });
  React.useEffect(() => {
    let cancelled = false;
    setState((s) => ({ ...s, loading: true }));
    fetcher()
      .then((data) => {
        if (!cancelled) setState({ data, error: null, loading: false });
      })
      .catch((err) => {
        if (cancelled) return;
        setState({
          data: null,
          error: err instanceof Error ? err.message : 'Failed to load report',
          loading: false,
        });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state;
}

function ReportShell({
  title,
  loading,
  error,
  children,
}: {
  title: string;
  loading: boolean;
  error: string | null;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <p className="py-6 text-center text-sm text-muted-foreground">Loading…</p>
        ) : error ? (
          <p className="py-6 text-center text-sm text-danger">{error}</p>
        ) : (
          children
        )}
      </CardContent>
    </Card>
  );
}

function SalesSummaryCard({
  session,
  branchId,
  range,
}: {
  session: Session;
  branchId: string;
  range: { from: string; to: string };
}) {
  const { data, error, loading } = useReport<SalesSummaryView>(
    `sales:${branchId}:${range.from}:${range.to}`,
    () => restaurantReports.salesSummary(session, branchId, range),
  );
  return (
    <ReportShell title="Sales summary" loading={loading} error={error}>
      {data ? (
        <dl className="grid grid-cols-2 gap-3 text-sm">
          <Stat label="Sessions closed" value={String(data.sessionsClosed)} />
          <Stat label="Orders served" value={String(data.ordersServed)} />
          <Stat label="Items sold" value={data.itemsSold} />
          <Stat label="Net revenue" value={formatMoney(data.netRevenue)} />
          <Stat label="Service charge" value={formatMoney(data.serviceChargeCollected)} />
          <Stat label="Payments collected" value={formatMoney(data.paymentsCollected)} />
        </dl>
      ) : null}
    </ReportShell>
  );
}

function TopItemsCard({
  session,
  branchId,
  range,
}: {
  session: Session;
  branchId: string;
  range: { from: string; to: string };
}) {
  const { data, error, loading } = useReport<TopMenuItemView[]>(
    `top:${branchId}:${range.from}:${range.to}`,
    () => restaurantReports.topItems(session, branchId, { ...range, limit: 10 }),
  );
  return (
    <ReportShell title="Top items" loading={loading} error={error}>
      {data && data.length > 0 ? (
        <table className="w-full text-sm">
          <thead className="text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="pb-1 text-left">Item</th>
              <th className="pb-1 text-right">Qty</th>
              <th className="pb-1 text-right">Revenue</th>
            </tr>
          </thead>
          <tbody>
            {data.map((row) => (
              <tr key={row.menuItemId} className="border-t border-border">
                <td className="py-1.5">{row.menuItemName}</td>
                <td className="py-1.5 text-right">{row.quantitySold}</td>
                <td className="py-1.5 text-right">{formatMoney(row.revenue)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="py-6 text-center text-sm text-muted-foreground">No items in this range.</p>
      )}
    </ReportShell>
  );
}

function WaiterPerformanceCard({
  session,
  branchId,
  range,
}: {
  session: Session;
  branchId: string;
  range: { from: string; to: string };
}) {
  const { data, error, loading } = useReport<WaiterPerformanceRow[]>(
    `waiters:${branchId}:${range.from}:${range.to}`,
    () => restaurantReports.waiterPerformance(session, branchId, range),
  );
  return (
    <ReportShell title="Waiter performance" loading={loading} error={error}>
      {data && data.length > 0 ? (
        <table className="w-full text-sm">
          <thead className="text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="pb-1 text-left">User</th>
              <th className="pb-1 text-right">Sessions</th>
              <th className="pb-1 text-right">Rounds</th>
              <th className="pb-1 text-right">Revenue</th>
            </tr>
          </thead>
          <tbody>
            {data.map((row) => (
              <tr key={row.userId} className="border-t border-border">
                <td className="py-1.5 font-mono text-xs">{row.userId.slice(0, 8)}</td>
                <td className="py-1.5 text-right">{row.sessionsHandled}</td>
                <td className="py-1.5 text-right">{row.roundsSubmitted}</td>
                <td className="py-1.5 text-right">{formatMoney(row.totalRevenue)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="py-6 text-center text-sm text-muted-foreground">
          No waiter activity in this range.
        </p>
      )}
    </ReportShell>
  );
}

function PaymentBreakdownCard({
  session,
  branchId,
  range,
}: {
  session: Session;
  branchId: string;
  range: { from: string; to: string };
}) {
  const { data, error, loading } = useReport<PaymentBreakdownRow[]>(
    `payments:${branchId}:${range.from}:${range.to}`,
    () => restaurantReports.paymentBreakdown(session, branchId, range),
  );
  const totalAmt = data ? data.reduce((s, r) => s + Number(r.amount), 0) : 0;
  return (
    <ReportShell title="Payment breakdown" loading={loading} error={error}>
      {data && data.length > 0 ? (
        <div className="space-y-2 text-sm">
          {data.map((row) => {
            const pct = totalAmt > 0 ? (Number(row.amount) / totalAmt) * 100 : 0;
            return (
              <div key={row.method}>
                <div className="flex items-center justify-between">
                  <span className="font-medium">{row.method}</span>
                  <span>
                    {formatMoney(row.amount)} · {row.count} tx
                  </span>
                </div>
                <div
                  aria-label={`${row.method} share`}
                  className="mt-1 h-2 overflow-hidden rounded-full bg-muted"
                >
                  <div
                    className="h-full bg-primary"
                    style={{ width: `${pct.toFixed(1)}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="py-6 text-center text-sm text-muted-foreground">No payments in this range.</p>
      )}
    </ReportShell>
  );
}

function ChannelBreakdownCard({
  session,
  branchId,
  range,
}: {
  session: Session;
  branchId: string;
  range: { from: string; to: string };
}) {
  const { data, error, loading } = useReport<ChannelBreakdownRow[]>(
    `channels:${branchId}:${range.from}:${range.to}`,
    () => restaurantReports.channels(session, branchId, range),
  );
  return (
    <ReportShell title="Channel breakdown" loading={loading} error={error}>
      {data && data.length > 0 ? (
        <ul className="space-y-1.5 text-sm">
          {data.map((row) => (
            <li key={row.channel} className="flex items-center justify-between">
              <span>{CHANNEL_LABELS[row.channel as RestaurantOrderChannel] ?? row.channel}</span>
              <span className="font-semibold">{row.orders} orders</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="py-6 text-center text-sm text-muted-foreground">
          No orders in this range.
        </p>
      )}
    </ReportShell>
  );
}

function VoidsCard({
  session,
  branchId,
  range,
}: {
  session: Session;
  branchId: string;
  range: { from: string; to: string };
}) {
  const { data, error, loading } = useReport<VoidReportRow[]>(
    `voids:${branchId}:${range.from}:${range.to}`,
    () => restaurantReports.voids(session, branchId, range),
  );
  return (
    <ReportShell title="Voids" loading={loading} error={error}>
      {data && data.length > 0 ? (
        <table className="w-full text-sm">
          <thead className="text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="pb-1 text-left">Item</th>
              <th className="pb-1 text-right">Qty</th>
              <th className="pb-1 text-left">Reason</th>
              <th className="pb-1 text-right">At</th>
            </tr>
          </thead>
          <tbody>
            {data.map((row) => (
              <tr key={row.itemId} className="border-t border-border">
                <td className="py-1.5">{row.menuItemName}</td>
                <td className="py-1.5 text-right">{row.quantity}</td>
                <td className="py-1.5">{row.reason || '—'}</td>
                <td className="py-1.5 text-right text-xs text-muted-foreground">
                  {row.voidedAt ? formatTime(row.voidedAt) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="py-6 text-center text-sm text-muted-foreground">No voids in this range.</p>
      )}
    </ReportShell>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-lg font-semibold">{value}</dd>
    </div>
  );
}
