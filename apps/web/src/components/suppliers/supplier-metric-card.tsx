import * as React from 'react';
import { type LucideIcon } from 'lucide-react';

import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';

/**
 * Compact, clickable summary metric. Rendered as a button so it's keyboard
 * operable and announced as an action; clicking applies the related filter.
 */
export function SupplierMetricCard({
  label,
  value,
  hint,
  icon: Icon,
  tone = 'brand',
  active = false,
  onClick,
  loading = false,
}: {
  label: string;
  value: string;
  hint?: string;
  icon: LucideIcon;
  tone?: 'brand' | 'success' | 'warning' | 'danger';
  active?: boolean;
  onClick?: () => void;
  loading?: boolean;
}) {
  const toneClasses: Record<typeof tone, string> = {
    brand: 'bg-brand-50 text-brand-700',
    success: 'bg-success-soft text-success',
    warning: 'bg-warning-soft text-warning',
    danger: 'bg-danger-soft text-danger',
  };

  return (
    <Card
      className={cn(
        'group p-0 transition-shadow',
        onClick && 'cursor-pointer hover:shadow-card-hover',
        active && 'ring-2 ring-ring',
      )}
    >
      <button
        type="button"
        onClick={onClick}
        aria-pressed={onClick ? active : undefined}
        disabled={!onClick}
        className="flex w-full items-start gap-3 rounded-2xl p-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
      >
        <span className={cn('inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl', toneClasses[tone])}>
          <Icon className="h-5 w-5" aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-xs font-medium text-muted-foreground">{label}</span>
          {loading ? (
            <span className="mt-1 block h-6 w-20 animate-pulse rounded bg-muted motion-reduce:animate-none" />
          ) : (
            <span className="block truncate text-xl font-semibold tracking-tight text-foreground">{value}</span>
          )}
          {hint ? <span className="mt-0.5 block truncate text-xs text-muted-foreground">{hint}</span> : null}
        </span>
      </button>
    </Card>
  );
}
