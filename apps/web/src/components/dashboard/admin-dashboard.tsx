'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  AlertCircle,
  AlertTriangle,
  ArrowLeftRight,
  BarChart3,
  Boxes,
  CalendarRange,
  CheckCircle2,
  Clock3,
  FileText,
  Info,
  Link2,
  PackagePlus,
  Plus,
  Receipt,
  RotateCcw,
  TrendingUp,
  Wallet,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import * as React from 'react';

import { buttonVariants } from '@/components/ui/button';
import type { Session } from '@/lib/auth';
import { buildComparison, paymentStatusMeta } from '@/lib/dashboard/adapters';
import {
  fetchSalesSeries,
  type PaymentMethodTotal,
  type RankedCategoryApi,
} from '@/lib/dashboard-api';
import {
  buildCategoryBars,
  buildPaymentBreakdown,
  createAccessibleChartSummary,
  formatCategoryMetric,
  formatDashboardCurrency,
  formatDashboardPercentage,
  type CategoryMetric,
  type PaymentMetric,
} from '@/lib/dashboard/chart-tokens';
import { firstNameOf, greetingFor } from '@/lib/dashboard/roles';
import { useDashboardData } from '@/lib/dashboard/use-dashboard-data';
import type { AlertItem } from '@/lib/dashboard/types';
import { Permission, type UserRole } from '@/lib/permissions';
import { cn, formatMoney } from '@/lib/utils';

import { AreaChart, type ChartPoint } from './charts';
import { ChartDataTable, Doughnut, HorizontalBars, type RankBar } from './data-charts';
import { DashboardHero, type HeroAction } from './hero';
import {
  CardSkeleton,
  EmptyState,
  ErrorState,
  KpiSkeleton,
  KPIGrid,
  Reveal,
  SectionCard,
  SegmentedControl,
  StatusPill,
  ViewAllLink,
  type MetricSpec,
} from './primitives';

const RANGES = [
  { value: '1D', label: 'Today' },
  { value: '7D', label: '7D' },
  { value: '30D', label: '30D' },
  { value: '3M', label: '3M' },
  { value: '6M', label: '6M' },
  { value: '1Y', label: '1Y' },
] as const;
type Range = (typeof RANGES)[number]['value'];

const count = (n: number) => Math.round(n).toLocaleString();

export function AdminDashboard({
  session,
  hasPermission,
}: {
  session: Session;
  hasPermission: (p: Permission) => boolean;
}) {
  const data = useDashboardData(session);
  const canReport = hasPermission(Permission.REPORT_READ);
  const canManageProducts = hasPermission(Permission.PRODUCT_MANAGE);
  const canQuickBooks = hasPermission(Permission.QUICKBOOKS_READ);

  const netSales = data.stats?.todaySalesTotal ?? 0;
  const txns = data.stats?.todayTransactions ?? 0;
  const inventoryValue = data.stats?.inventoryValue ?? 0;
  const stockedProducts = data.stats?.stockedProducts ?? 0;
  const summary = data.summary;

  const kpis: MetricSpec[] = [
    {
      icon: TrendingUp,
      metric: {
        id: 'net-sales',
        label: 'Net Sales',
        value: formatMoney(netSales),
        rawValue: netSales,
        format: formatMoney,
        helpText: "Total value of today's completed sales.",
        comparison: summary
          ? buildComparison(summary.netSales.value, summary.netSales.prevValue)
          : undefined,
        spark: summary?.netSales.series,
        destination: '/sales',
        surface: 'hero',
      },
    },
    ...(canReport
      ? [
          {
            icon: BarChart3,
            metric: {
              id: 'gross-profit',
              label: 'Gross Profit',
              value: formatMoney(summary?.grossProfit.value ?? 0),
              rawValue: summary?.grossProfit.value ?? 0,
              format: formatMoney,
              helpText:
                'Last 7 days: revenue minus known product costs (items without a cost price count at full margin).',
              comparison: summary
                ? buildComparison(summary.grossProfit.value, summary.grossProfit.prevValue)
                : undefined,
              spark: summary?.grossProfit.series,
              destination: '/sales',
              surface: 'aqua',
              iconAccent: 'aqua',
            },
          } satisfies MetricSpec,
        ]
      : []),
    {
      icon: Receipt,
      metric: {
        id: 'transactions',
        label: 'Transactions',
        value: count(txns),
        rawValue: txns,
        format: count,
        helpText: 'Number of sales completed today.',
        footnote: 'Completed today',
        destination: '/sales',
        iconAccent: 'info',
      },
    },
    {
      icon: Boxes,
      metric: {
        id: 'inventory-value',
        label: 'Total Inventory Value',
        value: formatMoney(inventoryValue),
        rawValue: inventoryValue,
        format: formatMoney,
        helpText:
          'Stock on hand valued at cost across active inventory products (items without a cost price count as zero).',
        footnote: `Across ${count(stockedProducts)} stocked products`,
        destination: '/products',
        iconAccent: 'aqua',
      },
    },
    {
      icon: FileText,
      metric: {
        id: 'open-quotations',
        label: 'Open Quotations',
        value: count(data.pipeline.openCount),
        rawValue: data.pipeline.openCount,
        format: count,
        helpText: 'Draft and sent quotations awaiting a decision.',
        footnote: 'Awaiting a decision',
        destination: '/quotations',
        iconAccent: 'lime',
      },
    },
  ];

  const secondary: HeroAction[] = [
    { key: 'quote', label: 'Create Quote', href: '/quotations/new', icon: FileText },
    ...(canManageProducts
      ? [{ key: 'product', label: 'Add Product', href: '/products/new', icon: PackagePlus }]
      : []),
    ...(canReport ? [{ key: 'reports', label: 'View Reports', href: '/sales', icon: BarChart3 }] : []),
  ];

  const alerts = buildAdminAlerts(data);
  const greeting = greetingFor(new Date().getHours());

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <DashboardHero
        greeting={greeting}
        name={firstNameOf(session.user.name)}
        subtitle="Here's what's happening across your business today."
        meta={[
          { key: 'window', icon: CalendarRange, label: 'Last 7 days' },
          ...(data.lastUpdatedLabel
            ? [{ key: 'updated', icon: Clock3, label: `Updated ${data.lastUpdatedLabel}` }]
            : []),
        ]}
        primary={{ key: 'sale', label: 'New Sale', href: '/pos', icon: Plus }}
        secondary={secondary}
        onRefresh={data.refresh}
        refreshing={data.loading}
      />

      {data.error && !data.stats ? (
        <SectionCard title="Dashboard unavailable">
          <ErrorState message={data.error} onRetry={data.refresh} />
        </SectionCard>
      ) : null}

      {/* KPI band */}
      {data.loading && !data.stats ? (
        <div className="@container">
          <div className="grid grid-cols-1 gap-4 @min-[640px]:grid-cols-2 @min-[1050px]:grid-cols-3 @min-[1400px]:grid-cols-5">
            <KpiSkeleton count={5} />
          </div>
        </div>
      ) : (
        <KPIGrid metrics={kpis} />
      )}

      {/* Row 2 — performance + attention */}
      <div className="grid min-w-0 gap-4 xl:grid-cols-12">
        <Reveal className="xl:col-span-8">
          <SalesPerformance session={session} />
        </Reveal>
        <Reveal index={1} className="xl:col-span-4">
          <AdminAlerts alerts={alerts} loading={data.loading && !data.stats} />
        </Reveal>
      </div>

      {/* Row 3 — mix + rankings + integration */}
      <div className="grid min-w-0 gap-4 md:grid-cols-2 xl:grid-cols-3">
        <Reveal>
          <PaymentMethodsCard totals={data.paymentMethods} loading={data.loading && !data.stats} />
        </Reveal>
        <Reveal index={1}>
          <TopCategoriesCard categories={data.topCategories} loading={data.loading && !data.stats} />
        </Reveal>
        <Reveal index={2} className="md:col-span-2 xl:col-span-1">
          <QuickBooksHealthCard health={data.quickbooks} canOpen={canQuickBooks} />
        </Reveal>
      </div>

      {/* Row 4 — activity + inventory / pipeline */}
      <div className="grid min-w-0 gap-4 xl:grid-cols-12">
        <Reveal className="xl:col-span-8">
          <RecentActivityCard data={data} />
        </Reveal>
        <div className="flex min-w-0 flex-col gap-4 xl:col-span-4">
          <Reveal index={1}>
            <InventoryAttentionCard stock={data.stock} loading={data.loading && !data.stats} />
          </Reveal>
          <Reveal index={2}>
            <QuotationPipelineCard
              pipeline={data.pipeline}
              loading={data.loading && !data.quotations.length}
            />
          </Reveal>
        </div>
      </div>

      <p className="pb-2 text-center text-xs text-muted-foreground">
        All amounts are in Sri Lankan Rupees (Rs.)
      </p>
    </div>
  );
}

// ── Sales performance ────────────────────────────────────────────────────────

const RANGE_DEF: Record<Range, { days: number; interval: 'day' | 'hour'; label: string }> = {
  '1D': { days: 1, interval: 'hour', label: 'today' },
  '7D': { days: 7, interval: 'day', label: 'the last 7 days' },
  '30D': { days: 30, interval: 'day', label: 'the last 30 days' },
  '3M': { days: 90, interval: 'day', label: 'the last 3 months' },
  '6M': { days: 180, interval: 'day', label: 'the last 6 months' },
  '1Y': { days: 365, interval: 'day', label: 'the last year' },
};

function SalesPerformance({ session }: { session: Session }) {
  const router = useRouter();
  const [range, setRange] = React.useState<Range>('7D');
  const [points, setPoints] = React.useState<ChartPoint[]>([]);
  const [prev, setPrev] = React.useState<ChartPoint[] | null>(null);
  const [state, setState] = React.useState<'loading' | 'ready' | 'error'>('loading');

  const load = React.useCallback(() => {
    const def = RANGE_DEF[range];
    const now = new Date();
    const from = new Date(now);
    from.setHours(0, 0, 0, 0);
    if (def.interval === 'hour') {
      // today only
    } else {
      from.setDate(from.getDate() - (def.days - 1));
    }
    const prevFrom = new Date(from);
    prevFrom.setDate(prevFrom.getDate() - def.days);
    const prevTo = new Date(from);

    setState('loading');
    const fmt = (bucket: string) =>
      def.interval === 'hour'
        ? new Date(bucket).toLocaleTimeString('en-LK', { hour: '2-digit' })
        : new Date(bucket).toLocaleDateString('en-LK', { day: '2-digit', month: 'short' });

    Promise.allSettled([
      fetchSalesSeries(session, { from, interval: def.interval }),
      def.interval === 'day'
        ? fetchSalesSeries(session, { from: prevFrom, to: prevTo, interval: def.interval })
        : Promise.resolve([]),
    ])
      .then(([cur, pre]) => {
        if (cur.status === 'fulfilled') {
          setPoints(cur.value.map((p) => ({ label: fmt(p.bucket), value: p.value })));
          setState('ready');
        } else {
          setState('error');
        }
        setPrev(
          pre.status === 'fulfilled' && pre.value.length > 1
            ? pre.value.map((p) => ({ label: fmt(p.bucket), value: p.value }))
            : null,
        );
      })
      .catch(() => setState('error'));
  }, [session, range]);

  React.useEffect(() => {
    let cancelled = false;
    if (!cancelled) load();
    return () => {
      cancelled = true;
    };
  }, [load]);

  const total = points.reduce((s, d) => s + d.value, 0);
  const def = RANGE_DEF[range];
  const prevTotal = prev?.reduce((s, d) => s + d.value, 0) ?? 0;
  const cmp = prev ? buildComparison(total, prevTotal, 'vs previous period') : undefined;

  return (
    <SectionCard
      title="Sales Performance"
      icon={TrendingUp}
      className="h-full"
      action={
        <SegmentedControl<Range>
          options={RANGES}
          value={range}
          onChange={setRange}
          ariaLabel="Sales performance range"
        />
      }
    >
      <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-2xl font-bold tracking-tight tabular-nums">{formatMoney(total)}</span>
        <span className="text-xs text-muted-foreground">net sales · {def.label}</span>
        {cmp ? (
          <span
            className={cn(
              'text-xs font-semibold',
              cmp.direction === 'up'
                ? 'text-success'
                : cmp.direction === 'down'
                  ? 'text-danger'
                  : 'text-muted-foreground',
            )}
          >
            {cmp.value > 0 ? '+' : ''}
            {cmp.value}% {cmp.label}
          </span>
        ) : null}
      </div>
      {state === 'loading' ? (
        <div className="h-44 w-full animate-pulse rounded-xl bg-muted" />
      ) : state === 'error' ? (
        <ErrorState message="Couldn't load the sales chart." onRetry={load} />
      ) : points.length === 0 ? (
        <EmptyState
          message="No sales in this period yet — completed sales will chart here."
          action={
            <Link href="/pos" className={buttonVariants({ size: 'sm' })}>
              <Plus className="h-4 w-4" />
              New Sale
            </Link>
          }
        />
      ) : (
        <AreaChart
          points={points}
          comparison={prev}
          valueFormat={formatMoney}
          ariaSummary={`Net sales for ${def.label}: ${formatMoney(total)} total across ${points.length} points.`}
          onSelect={() => router.push('/sales')}
        />
      )}
    </SectionCard>
  );
}

// ── QuickBooks health ────────────────────────────────────────────────────────

function QuickBooksHealthCard({
  health,
  canOpen,
}: {
  health: ReturnType<typeof useDashboardData>['quickbooks'];
  canOpen: boolean;
}) {
  const connected = health.state === 'connected';
  // Operational status is separate from connection status so the card never
  // shows "Connected" next to a red dot (a common contradictory pattern).
  const opTone =
    health.status === 'danger' ? 'danger' : health.status === 'warning' ? 'warning' : 'success';
  const opLabel = health.failedSyncs > 0 || health.waitingToSync > 0 ? health.statusLabel : 'Healthy';

  // Segmented health bar built only from real counts. When there is nothing to
  // sync we show a single full "healthy" segment rather than a fake split.
  const attention = health.waitingToSync + health.failedSyncs;
  const segments =
    attention > 0
      ? [
          { key: 'failed', value: health.failedSyncs, color: 'var(--color-danger)' },
          { key: 'waiting', value: health.waitingToSync, color: 'var(--color-info)' },
        ].filter((s) => s.value > 0)
      : [{ key: 'healthy', value: 1, color: 'var(--color-success)' }];
  const segTotal = segments.reduce((s, x) => s + x.value, 0);

  return (
    <SectionCard
      title="QuickBooks Health"
      icon={Link2}
      className="h-full"
      headerClassName={
        opTone === 'danger'
          ? 'bg-danger-soft/50'
          : opTone === 'warning'
            ? 'bg-warning-soft/50'
            : 'bg-brand-50/60'
      }
      iconClassName={connected ? 'bg-brand-50 text-brand-600' : undefined}
    >
      <div className="flex h-full flex-col gap-3">
        {/* Connection vs operational — two distinct, non-contradictory rows. */}
        <dl className="grid grid-cols-2 gap-2">
          <div className="rounded-xl bg-muted/60 px-3 py-2.5">
            <dt className="text-xs text-muted-foreground">Connection</dt>
            <dd className="mt-1">
              <StatusPill tone={connected ? 'success' : 'danger'}>
                {connected ? 'Connected' : 'Disconnected'}
              </StatusPill>
            </dd>
          </div>
          <div className="rounded-xl bg-muted/60 px-3 py-2.5">
            <dt className="text-xs text-muted-foreground">Operational</dt>
            <dd className="mt-1">
              <StatusPill tone={opTone}>{opLabel}</StatusPill>
            </dd>
          </div>
        </dl>

        {/* Segmented health visualization (real counts only). */}
        <div
          className="flex h-2 w-full overflow-hidden rounded-full bg-muted"
          role="img"
          aria-label={
            attention > 0
              ? `${count(health.failedSyncs)} failed and ${count(health.waitingToSync)} waiting records.`
              : 'All records synced — healthy.'
          }
        >
          {segments.map((s) => (
            <span
              key={s.key}
              style={{ width: `${(s.value / segTotal) * 100}%`, backgroundColor: s.color }}
            />
          ))}
        </div>

        <dl className="space-y-2 text-sm">
          <div className="flex items-center justify-between">
            <dt className="flex items-center gap-2 text-muted-foreground">
              <span className="h-2 w-2 rounded-full bg-info" aria-hidden />
              Waiting to sync
            </dt>
            <dd className={cn('font-semibold tabular-nums', health.waitingToSync > 0 && 'text-info')}>
              {count(health.waitingToSync)}
            </dd>
          </div>
          <div className="flex items-center justify-between">
            <dt className="flex items-center gap-2 text-muted-foreground">
              <span className="h-2 w-2 rounded-full bg-danger" aria-hidden />
              Failed syncs (recent)
            </dt>
            <dd className={cn('font-semibold tabular-nums', health.failedSyncs > 0 && 'text-danger')}>
              {count(health.failedSyncs)}
            </dd>
          </div>
          {/* TODO(api): expose "missing QuickBooks mappings" + last successful sync
              time on /dashboard/stats so they can be surfaced here as real values. */}
        </dl>
        {canOpen ? (
          <Link
            href="/quickbooks"
            className={cn(buttonVariants({ variant: 'outline', size: 'sm', fullWidth: true }), 'mt-auto')}
          >
            View sync log
          </Link>
        ) : null}
      </div>
    </SectionCard>
  );
}

// ── Business attention ───────────────────────────────────────────────────────

const SEVERITY_ICON: Record<AlertItem['severity'], LucideIcon> = {
  critical: AlertCircle,
  warning: AlertTriangle,
  info: Info,
};
/** Per-severity: left accent bar, tinted (never full-bleed) surface, icon well. */
const SEVERITY_STYLE: Record<
  AlertItem['severity'],
  { accent: string; surface: string; icon: string }
> = {
  critical: { accent: 'bg-danger', surface: 'bg-danger-soft/40', icon: 'bg-danger-soft text-danger' },
  warning: { accent: 'bg-warning', surface: 'bg-warning-soft/40', icon: 'bg-warning-soft text-warning' },
  info: { accent: 'bg-info', surface: 'bg-info-soft/40', icon: 'bg-info-soft text-info' },
};

const ATTENTION_FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'critical', label: 'Critical' },
  { value: 'warning', label: 'Warnings' },
] as const;
type AttentionFilter = (typeof ATTENTION_FILTERS)[number]['value'];

function AdminAlerts({ alerts, loading }: { alerts: AlertItem[]; loading: boolean }) {
  const [filter, setFilter] = React.useState<AttentionFilter>('all');
  const criticalCount = alerts.filter((a) => a.severity === 'critical').length;
  const warningCount = alerts.filter((a) => a.severity === 'warning').length;
  const shown = alerts.filter((a) =>
    filter === 'all' ? true : filter === 'critical' ? a.severity === 'critical' : a.severity === 'warning',
  );

  return (
    <SectionCard
      title="Business Attention"
      icon={AlertTriangle}
      className="h-full"
      iconClassName={criticalCount > 0 ? 'bg-danger-soft text-danger' : undefined}
      badge={
        alerts.length > 0 ? (
          <span className="flex items-center gap-1">
            {criticalCount > 0 ? (
              <span className="rounded-full bg-danger-soft px-1.5 py-0.5 text-[11px] font-semibold text-danger tabular-nums">
                {criticalCount} critical
              </span>
            ) : null}
            {warningCount > 0 ? (
              <span className="rounded-full bg-warning-soft px-1.5 py-0.5 text-[11px] font-semibold text-warning tabular-nums">
                {warningCount} warning
              </span>
            ) : null}
          </span>
        ) : null
      }
      action={
        alerts.length > 0 ? (
          <SegmentedControl<AttentionFilter>
            options={ATTENTION_FILTERS}
            value={filter}
            onChange={setFilter}
            ariaLabel="Filter business attention items"
          />
        ) : null
      }
    >
      {loading ? (
        <CardSkeleton rows={4} />
      ) : alerts.length === 0 ? (
        <EmptyState message="All clear — nothing needs your attention right now." />
      ) : shown.length === 0 ? (
        <EmptyState message={`No ${filter} items right now.`} />
      ) : (
        <ul className="space-y-2">
          {shown.map((a) => {
            const Icon = SEVERITY_ICON[a.severity];
            const s = SEVERITY_STYLE[a.severity];
            return (
              <li key={a.id}>
                <Link
                  href={a.destination}
                  className={cn(
                    'flex items-center gap-3 overflow-hidden rounded-xl p-2.5 pl-3 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    s.surface,
                    'hover:brightness-[0.98]',
                  )}
                >
                  <span className={cn('-ml-3 h-9 w-1 shrink-0 rounded-full', s.accent)} aria-hidden />
                  <span
                    className={cn(
                      'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg',
                      s.icon,
                    )}
                  >
                    <Icon className="h-5 w-5" aria-hidden />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{a.title}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {a.description}
                    </span>
                  </span>
                  {a.badge ? (
                    <span className="shrink-0 rounded-full bg-surface/80 px-2 py-0.5 text-xs font-semibold tabular-nums shadow-sm">
                      {a.badge}
                    </span>
                  ) : null}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </SectionCard>
  );
}

// ── Payment methods ──────────────────────────────────────────────────────────

const PAYMENT_VIEWS = [
  { value: 'chart', label: 'Chart' },
  { value: 'data', label: 'Data' },
] as const;
type ChartView = (typeof PAYMENT_VIEWS)[number]['value'];

const PAYMENT_METRICS = [
  { value: 'amount', label: 'Amount' },
  { value: 'transactions', label: 'Transactions' },
] as const;

function PaymentMethodsCard({
  totals,
  loading,
}: {
  totals: PaymentMethodTotal[];
  loading: boolean;
}) {
  const router = useRouter();
  const [view, setView] = React.useState<ChartView>('chart');
  const [metric, setMetric] = React.useState<PaymentMetric>('amount');
  const [active, setActive] = React.useState<string | null>(null);

  const hasCounts = totals.some((t) => (t.count ?? 0) > 0);
  const effMetric: PaymentMetric = hasCounts ? metric : 'amount';
  const bd = React.useMemo(
    () => buildPaymentBreakdown(totals, effMetric),
    [totals, effMetric],
  );

  const openMethod = (key: string) => {
    if (key === '__other__') return router.push('/sales');
    router.push(`/sales?paymentMethod=${encodeURIComponent(key)}`);
  };

  const summary = createAccessibleChartSummary(
    'Payment split for the selected period.',
    bd.slices.map((s) => ({ label: s.label, fraction: s.fraction })),
  );

  return (
    <SectionCard
      title="Payment Methods"
      icon={Wallet}
      className="h-full"
      headerClassName="bg-brand-50/50"
      iconClassName="bg-brand-50 text-brand-600"
      action={
        bd.slices.length > 0 ? (
          <SegmentedControl<ChartView>
            options={PAYMENT_VIEWS}
            value={view}
            onChange={setView}
            ariaLabel="Payment methods view"
          />
        ) : null
      }
    >
      {loading ? (
        <CardSkeleton rows={5} />
      ) : bd.slices.length === 0 ? (
        <EmptyState message="No payments in this period yet — the split appears as sales come in." />
      ) : view === 'data' ? (
        <ChartDataTable
          caption={summary}
          columns={[
            { key: 'method', label: 'Method' },
            { key: 'amount', label: 'Amount', align: 'right' },
            { key: 'pct', label: 'Share', align: 'right' },
            { key: 'count', label: 'Sales', align: 'right' },
          ]}
          rows={bd.slices.map((s) => ({
            key: s.key,
            accent: s.color,
            cells: [
              s.label,
              formatDashboardCurrency(s.amount),
              formatDashboardPercentage(s.fraction),
              count(s.count),
            ],
          }))}
        />
      ) : (
        <div className="space-y-4">
          {hasCounts ? (
            <div className="flex justify-center">
              <SegmentedControl<PaymentMetric>
                options={PAYMENT_METRICS}
                value={metric}
                onChange={setMetric}
                ariaLabel="Payment metric"
              />
            </div>
          ) : null}

          <Doughnut
            segments={bd.slices.map((s) => ({
              key: s.key,
              label: s.label,
              fraction: s.fraction,
              color: s.color,
            }))}
            activeKey={active}
            onActivate={setActive}
            onSelect={openMethod}
            ariaLabel={summary}
            center={
              active ? (
                <>
                  <span className="text-xs text-muted-foreground">
                    {bd.slices.find((s) => s.key === active)?.label}
                  </span>
                  <span className="text-lg font-bold tabular-nums">
                    {formatDashboardPercentage(bd.slices.find((s) => s.key === active)?.fraction ?? 0)}
                  </span>
                  <span className="text-[11px] tabular-nums text-muted-foreground">
                    {formatDashboardCurrency(bd.slices.find((s) => s.key === active)?.amount ?? 0)}
                  </span>
                </>
              ) : (
                <>
                  <span className="max-w-[7rem] text-xl font-bold leading-tight tabular-nums">
                    {formatDashboardCurrency(bd.totalAmount)}
                  </span>
                  <span className="text-[11px] text-muted-foreground">Total collected</span>
                </>
              )
            }
          />

          {bd.singleMethod && bd.slices[0] ? (
            <p className="text-center text-xs text-muted-foreground">
              All payments in this period were made in {bd.slices[0].label.toLowerCase()}.
            </p>
          ) : null}

          {/* Legend — amount · percentage · count, always visible (not tooltip-only). */}
          <ul className="space-y-1.5">
            {bd.slices.map((s) => {
              const dimmed = active != null && active !== s.key;
              return (
                <li key={s.key}>
                  <button
                    type="button"
                    onClick={() => openMethod(s.key)}
                    onMouseEnter={() => setActive(s.key)}
                    onMouseLeave={() => setActive(null)}
                    onFocus={() => setActive(s.key)}
                    onBlur={() => setActive(null)}
                    className={cn(
                      'flex w-full items-center gap-2.5 rounded-lg px-1.5 py-1 text-left transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      dimmed && 'opacity-45',
                    )}
                  >
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-sm"
                      style={{ backgroundColor: s.color }}
                      aria-hidden
                    />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">{s.label}</span>
                    <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                      {formatDashboardPercentage(s.fraction)} ·{' '}
                      {effMetric === 'transactions'
                        ? `${count(s.count)} sales · ${formatDashboardCurrency(s.amount)}`
                        : `${formatDashboardCurrency(s.amount)}${s.count > 0 ? ` · ${count(s.count)} sales` : ''}`}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </SectionCard>
  );
}

// ── Top categories ───────────────────────────────────────────────────────────

const CATEGORY_METRICS = [
  { value: 'amount', label: 'Revenue' },
  { value: 'units', label: 'Units' },
  { value: 'count', label: 'Sales' },
] as const;

function TopCategoriesCard({
  categories,
  loading,
}: {
  categories: RankedCategoryApi[];
  loading: boolean;
}) {
  const router = useRouter();
  const [metric, setMetric] = React.useState<CategoryMetric>('amount');
  const [view, setView] = React.useState<ChartView>('chart');
  const [active, setActive] = React.useState<string | null>(null);

  const bars = React.useMemo(() => buildCategoryBars(categories, metric), [categories, metric]);

  const rankBars: RankBar[] = bars.map((b) => ({
    key: b.key,
    rank: b.rank,
    label: b.label,
    ratio: b.ratio,
    valueLabel: formatCategoryMetric(b.metricValue, metric),
    metaLabel: formatDashboardPercentage(b.contribution),
    color: b.color,
    href: '/products',
  }));

  const summary = createAccessibleChartSummary(
    'Top categories by ' + (metric === 'amount' ? 'revenue' : metric === 'units' ? 'units sold' : 'sales') + '.',
    bars.map((b) => ({ label: b.label, fraction: b.contribution })),
  );

  const open = () => router.push('/products');

  return (
    <SectionCard
      title="Top Categories"
      icon={Boxes}
      className="h-full"
      headerClassName="bg-accent-soft/50"
      iconClassName="bg-accent-soft text-accent"
      action={
        <div className="flex items-center gap-1.5">
          <SegmentedControl<ChartView>
            options={PAYMENT_VIEWS}
            value={view}
            onChange={setView}
            ariaLabel="Top categories view"
          />
          <ViewAllLink href="/products" />
        </div>
      }
    >
      {loading ? (
        <CardSkeleton rows={5} />
      ) : bars.length === 0 ? (
        <EmptyState message="No category sales yet — rankings build as sales complete." />
      ) : (
        <div className="space-y-4">
          <div className="flex justify-start">
            <SegmentedControl<CategoryMetric>
              options={CATEGORY_METRICS}
              value={metric}
              onChange={setMetric}
              ariaLabel="Category metric"
            />
          </div>

          {view === 'data' ? (
            <ChartDataTable
              caption={summary}
              columns={[
                { key: 'rank', label: '#' },
                { key: 'cat', label: 'Category' },
                { key: 'val', label: CATEGORY_METRICS.find((m) => m.value === metric)?.label ?? '', align: 'right' },
                { key: 'share', label: 'Share', align: 'right' },
              ]}
              rows={bars.map((b) => ({
                key: b.key,
                accent: b.color,
                cells: [
                  b.rank,
                  b.label,
                  formatCategoryMetric(b.metricValue, metric),
                  formatDashboardPercentage(b.contribution),
                ],
              }))}
            />
          ) : (
            <HorizontalBars
              bars={rankBars}
              onNavigate={open}
              activeKey={active}
              onActivate={setActive}
            />
          )}
        </div>
      )}
    </SectionCard>
  );
}

// ── Quotation pipeline ───────────────────────────────────────────────────────

function QuotationPipelineCard({
  pipeline,
  loading,
}: {
  pipeline: ReturnType<typeof useDashboardData>['pipeline'];
  loading: boolean;
}) {
  return (
    <SectionCard
      title="Quotation Pipeline"
      icon={FileText}
      className="h-full"
      action={<ViewAllLink href="/quotations" />}
    >
      {loading ? (
        <CardSkeleton rows={4} />
      ) : pipeline.totalCount === 0 ? (
        <EmptyState message="No quotations in the current window." />
      ) : (
        <ul className="space-y-2.5 text-sm">
          {pipeline.stages.map((s) => (
            <li key={s.key} className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-2">
                <span className={cn('h-2 w-2 rounded-full', dotFor(s.tone))} aria-hidden />
                {s.label}
              </span>
              <span className="flex items-center gap-3">
                <span className="tabular-nums text-muted-foreground">{formatMoney(s.value)}</span>
                <span className="w-6 text-right font-semibold tabular-nums">{s.count}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

function dotFor(tone: string): string {
  return (
    {
      muted: 'bg-[var(--gray-400)]',
      primary: 'bg-primary',
      warning: 'bg-warning',
      success: 'bg-success',
      danger: 'bg-danger',
    }[tone] ?? 'bg-[var(--gray-400)]'
  );
}

// ── Inventory attention ──────────────────────────────────────────────────────

function InventoryAttentionCard({
  stock,
  loading,
}: {
  stock: { outOfStock: number; lowStock: number };
  loading: boolean;
}) {
  // Only out-of-stock and low-stock are exposed by the products API today.
  // TODO(api): add counts for missing image / missing category / missing
  // QuickBooks mapping so those rows can be shown here as real values.
  const rows = [
    stock.outOfStock > 0
      ? {
          key: 'out',
          tone: 'danger' as const,
          icon: XCircle,
          title: 'Out of stock',
          count: stock.outOfStock,
          href: '/products?stockStatus=OUT',
        }
      : null,
    stock.lowStock > 0
      ? {
          key: 'low',
          tone: 'warning' as const,
          icon: AlertTriangle,
          title: 'Low stock',
          count: stock.lowStock,
          href: '/products?stockStatus=LOW',
        }
      : null,
  ].filter(Boolean) as {
    key: string;
    tone: 'danger' | 'warning';
    icon: LucideIcon;
    title: string;
    count: number;
    href: string;
  }[];

  return (
    <SectionCard
      title="Inventory Attention"
      icon={Boxes}
      className="h-full"
      action={<ViewAllLink href="/products" />}
    >
      {loading ? (
        <CardSkeleton rows={2} />
      ) : rows.length === 0 ? (
        <EmptyState message="Stock levels look healthy — nothing below its alert threshold." />
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => {
            const Icon = r.icon;
            return (
              <li key={r.key}>
                <Link
                  href={r.href}
                  className="flex items-center justify-between gap-3 rounded-xl border border-border p-3 transition-colors hover:border-brand-200 hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="flex items-center gap-2.5">
                    <span
                      className={cn(
                        'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg',
                        r.tone === 'danger' ? 'bg-danger-soft text-danger' : 'bg-warning-soft text-warning',
                      )}
                      aria-hidden
                    >
                      <Icon className="h-4 w-4" />
                    </span>
                    <span className="text-sm font-medium">{r.title}</span>
                  </span>
                  <span className="flex items-baseline gap-1.5">
                    <span className="text-lg font-bold tabular-nums">{r.count}</span>
                    <span className="text-xs text-muted-foreground">items</span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </SectionCard>
  );
}

// ── Recent activity (responsive table → cards) ───────────────────────────────

/** Restrained per-status activity glyphs — colour rides the icon, never the row. */
const ACTIVITY_ICON: Record<'success' | 'warning' | 'danger' | 'muted', LucideIcon> = {
  success: CheckCircle2,
  warning: Clock3,
  danger: RotateCcw,
  muted: ArrowLeftRight,
};
const ACTIVITY_TONE: Record<'success' | 'warning' | 'danger' | 'muted', string> = {
  success: 'bg-success-soft text-success',
  warning: 'bg-warning-soft text-warning',
  danger: 'bg-danger-soft text-danger',
  muted: 'bg-info-soft text-info',
};

function RecentActivityCard({ data }: { data: ReturnType<typeof useDashboardData> }) {
  const rows = data.recentSales.slice(0, 6);
  return (
    <SectionCard
      title="Recent Business Activity"
      icon={Receipt}
      className="h-full"
      action={<ViewAllLink href="/sales" />}
    >
      {data.loading && data.recentSales.length === 0 ? (
        <CardSkeleton rows={6} />
      ) : rows.length === 0 ? (
        <EmptyState message="No sales recorded yet." />
      ) : (
        <div className="@container">
          {/* Table on wider content widths */}
          <table className="hidden w-full text-sm @min-[560px]:table">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th scope="col" className="pb-2 font-medium">Transaction</th>
                <th scope="col" className="pb-2 font-medium">Customer</th>
                <th scope="col" className="pb-2 text-right font-medium">Amount</th>
                <th scope="col" className="pb-2 text-right font-medium">Status</th>
                <th scope="col" className="pb-2 text-right font-medium">Time</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((s) => {
                const meta = paymentStatusMeta(s.paymentStatus, s.returnStatus);
                const failedSync = s.syncStatus === 'FAILED';
                const ActIcon = failedSync ? XCircle : ACTIVITY_ICON[meta.tone];
                return (
                  <tr key={s.id} className="group transition-colors hover:bg-muted/40">
                    <td className="py-2.5">
                      <Link
                        href={`/sales/${s.id}`}
                        className="flex items-center gap-2.5 font-medium hover:text-primary"
                      >
                        <span
                          className={cn(
                            'flex h-7 w-7 shrink-0 items-center justify-center rounded-lg',
                            failedSync ? 'bg-danger-soft text-danger' : ACTIVITY_TONE[meta.tone],
                          )}
                          aria-hidden
                        >
                          <ActIcon className="h-3.5 w-3.5" />
                        </span>
                        {s.saleNumber}
                      </Link>
                    </td>
                    <td className="py-2.5 text-muted-foreground">
                      {s.customerName ?? 'Walk-in Customer'}
                    </td>
                    <td className="py-2.5 text-right font-semibold tabular-nums">
                      {formatMoney(s.total)}
                    </td>
                    <td className="py-2.5 text-right">
                      <StatusPill tone={meta.tone}>{meta.label}</StatusPill>
                    </td>
                    <td className="py-2.5 text-right text-xs tabular-nums text-muted-foreground">
                      {new Date(s.createdAt).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {/* Card list on narrow content widths */}
          <ul className="divide-y divide-border @min-[560px]:hidden">
            {rows.map((s) => {
              const meta = paymentStatusMeta(s.paymentStatus, s.returnStatus);
              const failedSync = s.syncStatus === 'FAILED';
              const ActIcon = failedSync ? XCircle : ACTIVITY_ICON[meta.tone];
              return (
                <li key={s.id}>
                  <Link href={`/sales/${s.id}`} className="flex items-center gap-3 py-2.5">
                    <span
                      className={cn(
                        'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg',
                        failedSync ? 'bg-danger-soft text-danger' : ACTIVITY_TONE[meta.tone],
                      )}
                      aria-hidden
                    >
                      <ActIcon className="h-4 w-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{s.saleNumber}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {s.customerName ?? 'Walk-in Customer'}
                      </span>
                    </span>
                    <span className="shrink-0 text-right">
                      <span className="block text-sm font-semibold tabular-nums">
                        {formatMoney(s.total)}
                      </span>
                      <StatusPill tone={meta.tone}>{meta.label}</StatusPill>
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </SectionCard>
  );
}

/** Real, actionable alerts from live data, sorted by severity. */
function buildAdminAlerts(data: ReturnType<typeof useDashboardData>): AlertItem[] {
  const alerts: AlertItem[] = [];
  if (data.stock.outOfStock > 0) {
    alerts.push({
      id: 'out-of-stock',
      severity: 'critical',
      title: 'Out-of-stock products',
      description: `${data.stock.outOfStock} products are out of stock`,
      badge: String(data.stock.outOfStock),
      actionLabel: 'Review products',
      destination: '/products?stockStatus=OUT',
    });
  }
  if (data.stock.lowStock > 0) {
    alerts.push({
      id: 'low-stock',
      severity: 'warning',
      title: 'Low-stock items',
      description: `${data.stock.lowStock} products need attention`,
      badge: String(data.stock.lowStock),
      actionLabel: 'Review products',
      destination: '/products?stockStatus=LOW',
    });
  }
  if (data.quickbooks.failedSyncs > 0) {
    alerts.push({
      id: 'failed-syncs',
      severity: 'critical',
      title: 'Failed QuickBooks syncs',
      description: `${data.quickbooks.failedSyncs} recent sales failed to sync`,
      badge: String(data.quickbooks.failedSyncs),
      actionLabel: 'Open QuickBooks',
      destination: '/quickbooks',
    });
  }
  if (data.quickbooks.waitingToSync > 0) {
    alerts.push({
      id: 'waiting-sync',
      severity: 'info',
      title: 'Records waiting to sync',
      description: `${data.quickbooks.waitingToSync} records queued for QuickBooks`,
      badge: String(data.quickbooks.waitingToSync),
      actionLabel: 'Open QuickBooks',
      destination: '/quickbooks',
    });
  }
  if (data.pipeline.openCount > 0) {
    alerts.push({
      id: 'open-quotes',
      severity: 'info',
      title: 'Open quotations',
      description: `${data.pipeline.openCount} quotations awaiting a decision`,
      badge: String(data.pipeline.openCount),
      actionLabel: 'Review quotations',
      destination: '/quotations',
    });
  }
  const order = { critical: 0, warning: 1, info: 2 };
  return alerts.sort((a, b) => order[a.severity] - order[b.severity]);
}

// Keep the role type import used (documents intended consumers of this view).
export type AdminDashboardRole = Extract<UserRole, 'OWNER' | 'ADMIN' | 'MANAGER' | 'ACCOUNTANT'>;
