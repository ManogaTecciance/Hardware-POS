'use client';

import Link from 'next/link';
import {
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  Info,
  type LucideIcon,
} from 'lucide-react';
import * as React from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';
import type { DashboardMetric } from '@/lib/dashboard/types';
import { cn } from '@/lib/utils';

import { AnimatedNumber, Sparkline } from './charts';

const TREND_TONE = {
  up: 'text-success',
  down: 'text-danger',
  neutral: 'text-muted-foreground',
} as const;

/** Staggered entrance wrapper. Reduced-motion is neutralised globally in CSS. */
export function Reveal({
  index = 0,
  className,
  children,
}: {
  index?: number;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn('dash-enter min-w-0', className)} style={{ animationDelay: `${index * 45}ms` }}>
      {children}
    </div>
  );
}

function InfoDot({ label }: { label: string }) {
  return (
    <Tooltip label={label}>
      <span
        className="inline-flex text-muted-foreground/60 transition-colors hover:text-muted-foreground"
        tabIndex={0}
        role="img"
        aria-label={label}
      >
        <Info className="h-3.5 w-3.5" />
      </span>
    </Tooltip>
  );
}

/** Trend chip — direction is shown by arrow, colour AND sign (never colour alone). */
export function Trend({
  direction,
  value,
  label,
  onHero = false,
}: {
  direction: 'up' | 'down' | 'neutral';
  value: number;
  label: string;
  /** On the hero gradient surface, use Volt-Lime/white instead of semantic tones. */
  onHero?: boolean;
}) {
  const Icon = direction === 'up' ? ArrowUpRight : direction === 'down' ? ArrowDownRight : null;
  const tone = onHero
    ? direction === 'down'
      ? 'text-white'
      : 'text-[var(--axlo-volt-lime)]'
    : TREND_TONE[direction];
  return (
    <span className={cn('inline-flex items-center gap-1 text-xs font-semibold', tone)}>
      {Icon ? <Icon className="h-3.5 w-3.5" aria-hidden /> : null}
      {value > 0 ? '+' : ''}
      {value}%
      <span className={cn('font-normal', onHero ? 'text-white/70' : 'text-muted-foreground')}>
        {' '}
        {label}
      </span>
    </span>
  );
}

/**
 * KPI card. Renders as a link when a destination is set (keyboard-accessible).
 * Full-height flex column so cards in a row match height and the trend/sparkline
 * pins to the bottom — no card ever looks unfinished. Count-ups when `rawValue`
 * is supplied.
 */
const ICON_ACCENT: Record<NonNullable<DashboardMetric['iconAccent']>, string> = {
  teal: 'bg-brand-50 text-brand-600 ring-brand-100 group-hover:bg-brand-100',
  aqua: 'bg-accent-soft text-accent ring-accent/20 group-hover:bg-accent-soft',
  info: 'bg-info-soft text-info ring-info/20 group-hover:bg-info-soft',
  lime: 'bg-highlight-soft text-[var(--sem-chart-highlight)] ring-highlight/30 group-hover:bg-highlight-soft',
};

export function MetricCard({ metric, icon: Icon }: { metric: DashboardMetric; icon: LucideIcon }) {
  const cmp = metric.comparison;
  const hasSpark = !!metric.spark && metric.spark.length > 1;
  const hero = metric.surface === 'hero';
  const aquaSurface = metric.surface === 'aqua';
  const iconAccent = ICON_ACCENT[metric.iconAccent ?? 'teal'];

  const body = (
    <>
      {hero ? (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-[0.14]"
          style={{
            backgroundImage:
              'radial-gradient(circle at 88% 12%, var(--axlo-volt-lime) 0, transparent 42%)',
          }}
        />
      ) : null}
      <div className="relative flex items-start justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <span
            className={cn(
              'text-sm font-medium',
              hero ? 'text-white/85' : 'text-muted-foreground',
            )}
          >
            {metric.label}
          </span>
          {metric.helpText ? <InfoDot label={metric.helpText} /> : null}
        </div>
        <span
          className={cn(
            'flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ring-1 ring-inset transition-colors',
            hero ? 'bg-white/15 text-white ring-white/25' : iconAccent,
          )}
        >
          <Icon className="h-5 w-5" aria-hidden />
        </span>
      </div>
      <div
        className={cn(
          'relative mt-2.5 text-[1.75rem] font-bold leading-none tracking-tight',
          hero && 'text-white',
        )}
      >
        {metric.rawValue != null ? (
          <AnimatedNumber value={metric.rawValue} format={metric.format ?? String} />
        ) : (
          <span className="tabular-nums">{metric.value}</span>
        )}
      </div>
      {cmp ? (
        <div className="relative mt-2 flex min-h-5 items-center">
          <Trend direction={cmp.direction} value={cmp.value} label={cmp.label} onHero={hero} />
        </div>
      ) : null}
      <div className="relative mt-auto pt-3">
        {hasSpark ? (
          <div
            className={cn(
              hero ? 'text-[var(--axlo-volt-lime)]' : cmp ? TREND_TONE[cmp.direction] : 'text-primary/70',
            )}
          >
            <Sparkline data={metric.spark!} />
          </div>
        ) : metric.footnote ? (
          <p className={cn('text-xs', hero ? 'text-white/75' : 'text-muted-foreground')}>
            {metric.footnote}
          </p>
        ) : null}
      </div>
    </>
  );

  const base = cn(
    'group relative flex h-full flex-col overflow-hidden rounded-2xl border p-4 shadow-card transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
    hero
      ? 'border-transparent bg-gradient-to-br from-[var(--axlo-kinetic-teal)] to-[var(--axlo-flow-aqua)]'
      : aquaSurface
        ? 'border-accent/20 bg-accent-soft'
        : 'border-border bg-card',
  );
  const hover = hero
    ? 'hover:-translate-y-0.5 hover:shadow-card-hover'
    : 'hover:-translate-y-0.5 hover:border-brand-200 hover:shadow-card-hover';
  return metric.destination ? (
    <Link href={metric.destination} className={cn(base, hover)} aria-label={`${metric.label}: ${metric.value}`}>
      {body}
    </Link>
  ) : (
    <div className={base}>{body}</div>
  );
}

export interface MetricSpec {
  metric: DashboardMetric;
  icon: LucideIcon;
}

/**
 * Container-aware KPI grid. Responds to the dashboard content width (not the
 * viewport) via CSS container queries, so it re-balances when the sidebar
 * collapses/expands at the same viewport. Optimised for the 5-card case and
 * degrades to a clean 1 / 2 / 4 grid with no orphan card for other counts.
 */
export function KPIGrid({ metrics }: { metrics: MetricSpec[] }) {
  const isFive = metrics.length === 5;
  return (
    <div className="@container">
      <div
        className={cn(
          'grid grid-cols-1 gap-4 @min-[640px]:grid-cols-2',
          // Five KPIs go single-row from ~960px of container width so laptops
          // keep one row whether the sidebar is expanded or collapsed.
          isFive ? '@min-[960px]:grid-cols-5' : '@min-[1100px]:grid-cols-4',
        )}
      >
        {metrics.map((m, i) => (
          <div
            key={m.metric.id}
            className={cn('dash-enter min-w-0', kpiCellClass(i, metrics.length))}
            style={{ animationDelay: `${i * 45}ms` }}
          >
            <MetricCard metric={m.metric} icon={m.icon} />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Per-card column spans that keep every breakpoint balanced (no orphan card). */
function kpiCellClass(i: number, n: number): string {
  if (n === 5) {
    // Two-column band only: the fifth card spans the row; from 960px all five
    // sit on one row.
    return i === 4 ? '@min-[640px]:col-span-2 @min-[960px]:col-span-1' : '';
  }
  const lastOdd = n % 2 === 1 && i === n - 1;
  return lastOdd ? '@min-[640px]:col-span-2 @min-[1100px]:col-span-1' : '';
}

/** Section card with a heading, optional icon/description and right-side action. */
export function SectionCard({
  title,
  description,
  icon: Icon,
  badge,
  action,
  className,
  headerClassName,
  iconClassName,
  children,
}: {
  title: string;
  description?: string;
  icon?: LucideIcon;
  badge?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
  /** Subtle header tint (e.g. `bg-brand-50/60`) — use sparingly, not every card. */
  headerClassName?: string;
  /** Icon-well accent classes to colour the section icon. */
  iconClassName?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      className={cn(
        'flex min-w-0 flex-col rounded-2xl border border-border bg-card shadow-card transition-shadow hover:shadow-card-hover',
        className,
      )}
    >
      <header
        className={cn(
          'flex items-center justify-between gap-3 border-b border-border px-4 py-3',
          headerClassName,
        )}
      >
        <div className="flex min-w-0 items-center gap-2.5">
          {Icon ? (
            <span
              className={cn(
                'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground',
                iconClassName,
              )}
            >
              <Icon className="h-4 w-4" aria-hidden />
            </span>
          ) : null}
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold tracking-tight">{title}</h2>
            {description ? (
              <p className="truncate text-xs text-muted-foreground">{description}</p>
            ) : null}
          </div>
          {badge}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </header>
      <div className="min-w-0 flex-1 p-4">{children}</div>
    </section>
  );
}

/** Accessible segmented control (tablist) — used for chart ranges/metrics. */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: readonly T[] | readonly { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  ariaLabel: string;
}) {
  const normalized = options.map((o) =>
    typeof o === 'string' ? { value: o as T, label: o as string } : o,
  );
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className="inline-flex items-center gap-0.5 rounded-lg bg-muted p-0.5"
    >
      {normalized.map((o) => {
        const selected = o.value === value;
        return (
          <button
            key={o.value}
            role="tab"
            aria-selected={selected}
            onClick={() => onChange(o.value)}
            className={cn(
              'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
              selected
                ? 'bg-surface text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** Ghost "View all →" link used in section headers. */
export function ViewAllLink({ href, label = 'View all' }: { href: string; label?: string }) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-1 rounded-md px-1 py-0.5 text-xs font-medium text-primary transition-colors hover:bg-brand-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {label}
      <ArrowRight className="h-3.5 w-3.5" />
    </Link>
  );
}

const BAR_TONE: Record<string, string> = {
  cash: 'bg-success',
  card: 'bg-primary',
  bank: 'bg-warning',
  qr: 'bg-accent',
  credit: 'bg-[var(--gray-400)]',
  other: 'bg-[var(--gray-300)]',
  primary: 'bg-primary',
  accent: 'bg-accent',
  neutral: 'bg-[var(--gray-400)]',
};

export function ProgressBar({ percent, tone = 'primary' }: { percent: number; tone?: string }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
      <div
        className={cn('h-full rounded-full transition-[width] duration-500', BAR_TONE[tone] ?? 'bg-primary')}
        style={{ width: `${Math.max(0, Math.min(100, percent))}%` }}
      />
    </div>
  );
}

const STATUS_VARIANT = {
  success: 'success',
  warning: 'warning',
  danger: 'danger',
  muted: 'neutral',
} as const;

const STATUS_DOT = {
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
  muted: 'bg-[var(--gray-400)]',
} as const;

/** Status pill — colour is never the sole signal; a dot + text always accompany it. */
export function StatusPill({
  tone,
  children,
}: {
  tone: keyof typeof STATUS_VARIANT;
  children: React.ReactNode;
}) {
  return (
    <Badge variant={STATUS_VARIANT[tone]}>
      <span className={cn('h-1.5 w-1.5 rounded-full', STATUS_DOT[tone])} aria-hidden />
      {children}
    </Badge>
  );
}

// ── loading / empty / error states ───────────────────────────────────────────

export function KpiSkeleton({ count }: { count: number }) {
  return (
    <>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="rounded-2xl border border-border bg-card p-4 shadow-card">
          <div className="h-4 w-24 animate-pulse rounded bg-muted" />
          <div className="mt-3 h-7 w-32 animate-pulse rounded bg-muted" />
          <div className="mt-3 h-7 w-full animate-pulse rounded bg-muted" />
        </div>
      ))}
    </>
  );
}

export function CardSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-2.5">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="h-9 w-full animate-pulse rounded-lg bg-muted" />
      ))}
    </div>
  );
}

export function EmptyState({ message, action }: { message: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-8 text-center">
      <p className="max-w-xs text-sm text-muted-foreground">{message}</p>
      {action}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-8 text-center">
      <p className="text-sm text-danger">{message}</p>
      {onRetry ? (
        <Button variant="outline" size="sm" onClick={onRetry}>
          Retry
        </Button>
      ) : null}
    </div>
  );
}
