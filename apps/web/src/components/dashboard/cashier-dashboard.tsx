'use client';

import Link from 'next/link';
import {
  Banknote,
  Clock3,
  FileText,
  MonitorSmartphone,
  PauseCircle,
  Plus,
  Receipt,
  RefreshCcw,
  ScanLine,
  ShoppingCart,
  Undo2,
  UserPlus,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import * as React from 'react';

import { buttonVariants } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';
import type { Session } from '@/lib/auth';
import { buildShiftSummary, paymentStatusMeta } from '@/lib/dashboard/adapters';
import { firstNameOf, greetingFor } from '@/lib/dashboard/roles';
import type { ShiftSummary } from '@/lib/dashboard/types';
import { useDashboardData } from '@/lib/dashboard/use-dashboard-data';
import { Permission } from '@/lib/permissions';
import { cn, formatMoney, formatMoneyCompact } from '@/lib/utils';

import { DashboardHero, type HeroAction } from './hero';
import {
  CardSkeleton,
  EmptyState,
  KpiSkeleton,
  KPIGrid,
  Reveal,
  SectionCard,
  StatusPill,
  ViewAllLink,
  type MetricSpec,
} from './primitives';

const count = (n: number) => Math.round(n).toLocaleString();

export function CashierDashboard({
  session,
  hasPermission,
}: {
  session: Session;
  hasPermission: (p: Permission) => boolean;
}) {
  const data = useDashboardData(session, 'cashier');
  const canReturn = hasPermission(Permission.RETURN_CREATE);
  const canQuote = hasPermission(Permission.QUOTATION_CREATE);
  const canAddCustomer = hasPermission(Permission.CUSTOMER_MANAGE);

  const todaySales = data.stats?.todaySalesTotal ?? 0;
  const txns = data.stats?.todayTransactions ?? 0;
  const avgBill = txns > 0 ? todaySales / txns : 0;
  const shift = buildShiftSummary(data.shift);
  const spark = data.summary?.netSales.series;

  const kpis: MetricSpec[] = [
    {
      icon: Wallet,
      metric: {
        id: 'today-sales',
        label: 'Shift Sales',
        value: formatMoneyCompact(todaySales),
        rawValue: todaySales,
        format: formatMoneyCompact,
        helpText: 'Total value of sales you completed today.',
        spark,
        destination: '/sales',
      },
    },
    {
      icon: Receipt,
      metric: {
        id: 'txns-today',
        label: 'Transactions',
        value: count(txns),
        rawValue: txns,
        format: count,
        helpText: 'Number of sales you completed today.',
        footnote: 'Completed today',
        destination: '/sales',
      },
    },
    {
      icon: ShoppingCart,
      metric: {
        id: 'avg-bill',
        label: 'Average Bill',
        value: formatMoneyCompact(avgBill),
        rawValue: avgBill,
        format: formatMoneyCompact,
        helpText: "Today's sales divided by your transactions.",
        footnote: `Across ${count(txns)} sales`,
      },
    },
    {
      icon: Banknote,
      metric: {
        id: 'drawer',
        label: 'Expected Cash',
        value: formatMoneyCompact(shift.expectedCash),
        rawValue: shift.expectedCash,
        format: formatMoneyCompact,
        helpText: 'Cash received today minus refunds (no drawer counts yet).',
        footnote: 'Cash in drawer, expected',
      },
    },
  ];

  const secondary: HeroAction[] = [
    ...(canQuote ? [{ key: 'quote', label: 'Create Quote', href: '/quotations/new', icon: FileText }] : []),
    ...(canReturn ? [{ key: 'return', label: 'Process Return', href: '/returns/new', icon: Undo2 }] : []),
  ];

  const greeting = greetingFor(new Date().getHours());
  const registerReady = session.registerName && session.registerName !== '—';

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <DashboardHero
        greeting={greeting}
        name={firstNameOf(session.user.name)}
        subtitle={
          registerReady
            ? `${session.registerName} is ready — start a sale or pick up where you left off.`
            : 'Start a sale or pick up where you left off.'
        }
        meta={[
          { key: 'register', icon: MonitorSmartphone, label: session.registerName },
          ...(data.lastUpdatedLabel
            ? [{ key: 'updated', icon: Clock3, label: `Updated ${data.lastUpdatedLabel}` }]
            : []),
        ]}
        primary={{ key: 'sale', label: 'Start New Sale', href: '/pos', icon: Plus }}
        secondary={secondary}
        onRefresh={data.refresh}
        refreshing={data.loading}
      />

      {/* KPI band */}
      {data.loading && !data.stats ? (
        <div className="@container">
          <div className="grid grid-cols-1 gap-4 @min-[640px]:grid-cols-2 @min-[1100px]:grid-cols-4">
            <KpiSkeleton count={4} />
          </div>
        </div>
      ) : (
        <KPIGrid metrics={kpis} />
      )}

      {/* Row 2 — shift + quick actions */}
      <div className="grid min-w-0 gap-4 xl:grid-cols-12">
        <Reveal className="xl:col-span-7">
          <ShiftSummaryCard shift={shift} />
        </Reveal>
        <Reveal index={1} className="xl:col-span-5">
          <QuickActionsCard
            canAddCustomer={canAddCustomer}
            canQuote={canQuote}
            canReturn={canReturn}
          />
        </Reveal>
      </div>

      {/* Row 3 — recent sales + register health */}
      <div className="grid min-w-0 gap-4 xl:grid-cols-12">
        <Reveal className="xl:col-span-8">
          <RecentSalesCard data={data} />
        </Reveal>
        <Reveal index={1} className="xl:col-span-4">
          <RegisterHealthCard shift={shift} health={data.quickbooks} />
        </Reveal>
      </div>

      <p className="pb-2 text-center text-xs text-muted-foreground">
        All amounts are in Sri Lankan Rupees (Rs.)
      </p>
    </div>
  );
}

// ── Current shift ────────────────────────────────────────────────────────────

function ShiftSummaryCard({ shift }: { shift: ShiftSummary }) {
  const diff = shift.difference;
  const diffLabel =
    diff === 0 ? 'Balanced' : diff > 0 ? `Over by ${formatMoney(diff)}` : `Short by ${formatMoney(-diff)}`;
  const diffTone = diff === 0 ? 'success' : diff > 0 ? 'warning' : 'danger';

  return (
    <SectionCard
      title="Current Shift"
      icon={Clock3}
      className="h-full"
      badge={<StatusPill tone={shift.isOpen ? 'success' : 'muted'}>{shift.isOpen ? 'Open' : 'No activity'}</StatusPill>}
    >
      <div className="@container">
        <div className="grid gap-4 @min-[520px]:grid-cols-2">
          <dl className="space-y-2.5 text-sm">
            <SummaryRow label="Shift started" value={shift.startedAtLabel} />
            <SummaryRow label="Starting cash" value={formatMoney(shift.startingCash)} />
            <SummaryRow label="Cash sales" value={formatMoney(shift.cashSales)} />
            <SummaryRow label="Card sales" value={formatMoney(shift.cardSales)} />
          </dl>
          <dl className="space-y-2.5 text-sm">
            <SummaryRow label="Bank / QR sales" value={formatMoney(shift.bankQrSales)} />
            <SummaryRow label="Refunds (cash)" value={`- ${formatMoney(shift.refunds)}`} tone="danger" />
            <SummaryRow label="Expected cash" value={formatMoney(shift.expectedCash)} strong />
            <SummaryRow label="Drawer balance" value={formatMoney(shift.drawerBalance)} strong />
          </dl>
        </div>
      </div>
      <div
        className={cn(
          'mt-4 flex items-center justify-between rounded-xl px-3 py-3',
          diffTone === 'success' ? 'bg-success-soft' : diffTone === 'warning' ? 'bg-warning-soft' : 'bg-danger-soft',
        )}
      >
        <span className="text-sm font-medium text-muted-foreground">Drawer difference</span>
        <StatusPill tone={diffTone}>{diffLabel}</StatusPill>
      </div>
    </SectionCard>
  );
}

function SummaryRow({
  label,
  value,
  tone,
  strong,
}: {
  label: string;
  value: string;
  tone?: 'danger';
  strong?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          'tabular-nums',
          strong ? 'font-semibold' : 'font-medium',
          tone === 'danger' && 'text-danger',
        )}
      >
        {value}
      </dd>
    </div>
  );
}

// ── Quick actions (large touch tiles) ────────────────────────────────────────

interface QuickAction {
  key: string;
  label: string;
  icon: LucideIcon;
  href?: string;
  primary?: boolean;
  disabledReason?: string;
}

function QuickActionsCard({
  canAddCustomer,
  canQuote,
  canReturn,
}: {
  canAddCustomer: boolean;
  canQuote: boolean;
  canReturn: boolean;
}) {
  const actions: QuickAction[] = [
    { key: 'new-sale', label: 'New Sale', icon: ShoppingCart, href: '/pos', primary: true },
    { key: 'scan', label: 'Scan Barcode', icon: ScanLine, href: '/pos' },
    { key: 'find-sale', label: 'Find Sale', icon: Receipt, href: '/sales' },
    ...(canAddCustomer
      ? [{ key: 'add-customer', label: 'Add Customer', icon: UserPlus, href: '/customers/new' }]
      : []),
    ...(canQuote
      ? [{ key: 'create-quote', label: 'Create Quote', icon: FileText, href: '/quotations/new' }]
      : []),
    ...(canReturn
      ? [{ key: 'return', label: 'Process Return', icon: Undo2, href: '/returns/new' }]
      : []),
    {
      key: 'resume-hold',
      label: 'Resume Hold',
      icon: PauseCircle,
      disabledReason: "Held sales aren't available yet",
    },
  ];

  const base =
    'flex min-h-[4.5rem] flex-col items-center justify-center gap-1.5 rounded-2xl border p-3 text-center transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1';

  return (
    <SectionCard title="Quick Actions" icon={ShoppingCart} className="h-full">
      <div className="grid grid-cols-2 gap-2.5 @min-[420px]:grid-cols-3">
        {actions.map((a) => {
          const inner = (
            <>
              <a.icon className="h-6 w-6" aria-hidden />
              <span className="text-xs font-semibold leading-tight">{a.label}</span>
            </>
          );
          if (a.disabledReason) {
            return (
              <Tooltip key={a.key} label={a.disabledReason} className="w-full">
                <span
                  className={cn(base, 'w-full cursor-not-allowed border-border text-muted-foreground opacity-60')}
                  aria-disabled
                >
                  {inner}
                </span>
              </Tooltip>
            );
          }
          return (
            <Link
              key={a.key}
              href={a.href ?? '#'}
              className={cn(
                base,
                a.primary
                  ? 'border-primary bg-primary text-primary-foreground shadow-card hover:-translate-y-0.5 hover:shadow-card-hover'
                  : 'border-border hover:-translate-y-0.5 hover:border-brand-200 hover:bg-muted/60',
              )}
            >
              {inner}
            </Link>
          );
        })}
      </div>
    </SectionCard>
  );
}

// ── Recent sales ─────────────────────────────────────────────────────────────

function RecentSalesCard({ data }: { data: ReturnType<typeof useDashboardData> }) {
  return (
    <SectionCard title="Recent Sales" icon={Receipt} className="h-full" action={<ViewAllLink href="/sales" />}>
      {data.loading && data.recentSales.length === 0 ? (
        <CardSkeleton rows={6} />
      ) : data.recentSales.length === 0 ? (
        <EmptyState
          message="No sales completed during this shift yet."
          action={
            <Link href="/pos" className={buttonVariants({ size: 'sm' })}>
              <Plus className="h-4 w-4" />
              Start New Sale
            </Link>
          }
        />
      ) : (
        <ul className="divide-y divide-border">
          {data.recentSales.slice(0, 7).map((s) => {
            const meta = paymentStatusMeta(s.paymentStatus, s.returnStatus);
            const time = new Date(s.createdAt).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
            });
            return (
              <li key={s.id}>
                <Link
                  href={`/sales/${s.id}`}
                  className="flex items-center gap-3 py-2.5 transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="w-14 shrink-0 text-xs tabular-nums text-muted-foreground">{time}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">
                      {s.customerName ?? 'Walk-in Customer'}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">{s.saleNumber}</span>
                  </span>
                  <span className="shrink-0 text-right">
                    <span className="block text-sm font-semibold tabular-nums">{formatMoney(s.total)}</span>
                    <StatusPill tone={meta.tone}>{meta.label}</StatusPill>
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

// ── Register health (only what is truly knowable) ────────────────────────────

function RegisterHealthCard({
  shift,
  health,
}: {
  shift: ShiftSummary;
  health: ReturnType<typeof useDashboardData>['quickbooks'];
}) {
  const syncTone = health.failedSyncs > 0 ? 'danger' : health.waitingToSync > 0 ? 'warning' : 'success';
  const syncLabel =
    health.failedSyncs > 0
      ? `${health.failedSyncs} failed`
      : health.waitingToSync > 0
        ? `${health.waitingToSync} waiting`
        : 'Up to date';

  const rows: { key: string; icon: LucideIcon; label: string; tone: 'success' | 'warning' | 'danger' | 'muted'; value: string }[] = [
    {
      key: 'register',
      icon: MonitorSmartphone,
      label: 'Register',
      tone: shift.isOpen ? 'success' : 'muted',
      value: shift.isOpen ? `Open since ${shift.startedAtLabel}` : 'No activity yet',
    },
    {
      key: 'sync',
      icon: RefreshCcw,
      label: 'QuickBooks sync',
      tone: syncTone,
      value: syncLabel,
    },
  ];

  return (
    <SectionCard title="Register Health" icon={MonitorSmartphone} className="h-full">
      <ul className="space-y-2.5">
        {rows.map((r) => (
          <li
            key={r.key}
            className="flex items-center justify-between gap-3 rounded-xl border border-border p-3"
          >
            <span className="flex min-w-0 items-center gap-2.5">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                <r.icon className="h-4 w-4" aria-hidden />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-medium">{r.label}</span>
                <span className="block truncate text-xs text-muted-foreground">{r.value}</span>
              </span>
            </span>
            <StatusPill tone={r.tone}>
              {r.tone === 'success' ? 'OK' : r.tone === 'warning' ? 'Check' : r.tone === 'danger' ? 'Error' : 'Idle'}
            </StatusPill>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-muted-foreground">
        Printer and scanner status isn&apos;t monitored from here yet.
      </p>
    </SectionCard>
  );
}
