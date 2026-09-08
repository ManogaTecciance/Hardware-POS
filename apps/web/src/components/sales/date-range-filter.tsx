'use client';

import * as React from 'react';
import { CalendarDays, Check, ChevronDown } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { isValidYmd } from '@/lib/dates';
import { cn } from '@/lib/utils';

export type DateRangePreset = 'ALL' | 'TODAY' | 'WEEK' | 'MONTH' | 'YEAR' | 'CUSTOM';

/** The selected range: a preset, or CUSTOM with YYYY-MM-DD bounds (either optional). */
export interface DateRangeValue {
  preset: DateRangePreset;
  from?: string;
  to?: string;
}

const PRESETS: { key: Exclude<DateRangePreset, 'CUSTOM'>; label: string }[] = [
  { key: 'ALL', label: 'All time' },
  { key: 'TODAY', label: 'Today' },
  { key: 'WEEK', label: 'This week' },
  { key: 'MONTH', label: 'This month' },
  { key: 'YEAR', label: 'This year' },
];

/** Resolve the selection to inclusive ISO bounds for the API. */
export function resolveDateRange(value: DateRangeValue): { dateFrom?: string; dateTo?: string } {
  if (value.preset === 'ALL') return {};

  if (value.preset === 'CUSTOM') {
    const range: { dateFrom?: string; dateTo?: string } = {};
    if (isValidYmd(value.from)) {
      const from = new Date(value.from);
      from.setHours(0, 0, 0, 0);
      range.dateFrom = from.toISOString();
    }
    if (isValidYmd(value.to)) {
      // Inclusive upper bound: end of the selected day.
      const to = new Date(value.to);
      to.setHours(23, 59, 59, 999);
      range.dateTo = to.toISOString();
    }
    return range;
  }

  const now = new Date();
  const start = new Date(now);
  if (value.preset === 'TODAY') {
    start.setHours(0, 0, 0, 0);
  } else if (value.preset === 'WEEK') {
    const day = (start.getDay() + 6) % 7; // Monday-based week
    start.setDate(start.getDate() - day);
    start.setHours(0, 0, 0, 0);
  } else if (value.preset === 'MONTH') {
    start.setDate(1);
    start.setHours(0, 0, 0, 0);
  } else {
    // YEAR
    start.setMonth(0, 1);
    start.setHours(0, 0, 0, 0);
  }
  // No upper bound: presets are "from X onward", so sales completed while
  // the page is open still appear on the next fetch.
  return { dateFrom: start.toISOString() };
}

function formatDay(ymd: string): string {
  if (!isValidYmd(ymd)) return '—';
  return new Date(`${ymd}T00:00:00`).toLocaleDateString('en-LK', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

/** Human label for the control button — always states the active range. */
export function dateRangeLabel(value: DateRangeValue): string {
  if (value.preset !== 'CUSTOM') {
    return PRESETS.find((p) => p.key === value.preset)?.label ?? 'All time';
  }
  if (value.from && value.to) return `${formatDay(value.from)} – ${formatDay(value.to)}`;
  if (value.from) return `From ${formatDay(value.from)}`;
  if (value.to) return `Until ${formatDay(value.to)}`;
  return 'Custom range';
}

/**
 * Single date-range control: a button labelled with the active range that
 * opens a popover holding the presets and a custom from/to range — the
 * pattern used by most analytics/commerce dashboards.
 */
export function DateRangeFilter({
  value,
  onChange,
}: {
  value: DateRangeValue;
  onChange: (next: DateRangeValue) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [draftFrom, setDraftFrom] = React.useState(value.from ?? '');
  const [draftTo, setDraftTo] = React.useState(value.to ?? '');
  const rootRef = React.useRef<HTMLDivElement>(null);

  // Re-seed the custom drafts from the applied value each time the popover opens.
  const openPopover = () => {
    setDraftFrom(value.from ?? '');
    setDraftTo(value.to ?? '');
    setOpen(true);
  };

  React.useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const badFrom = !!draftFrom && !isValidYmd(draftFrom);
  const badTo = !!draftTo && !isValidYmd(draftTo);
  const invalidDraft =
    badFrom || badTo || (!!draftFrom && !!draftTo && draftFrom > draftTo);
  const canApply = (!!draftFrom || !!draftTo) && !invalidDraft;

  const applyCustom = () => {
    onChange({
      preset: 'CUSTOM',
      from: draftFrom || undefined,
      to: draftTo || undefined,
    });
    setOpen(false);
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : openPopover())}
        className={cn(
          'flex h-11 items-center gap-2 rounded-xl border border-border bg-surface px-3.5 text-sm font-medium transition-colors hover:bg-muted',
          value.preset !== 'ALL' && 'border-primary/40 text-primary',
        )}
      >
        <CalendarDays className="h-4 w-4 shrink-0" />
        {dateRangeLabel(value)}
        <ChevronDown className={cn('h-4 w-4 shrink-0 transition-transform', open && 'rotate-180')} />
      </button>

      {open ? (
        <div
          role="dialog"
          aria-label="Filter by date"
          className="absolute left-0 top-full z-40 mt-2 w-72 rounded-2xl border border-border bg-surface p-2 shadow-xl"
        >
          <ul>
            {PRESETS.map((p) => (
              <li key={p.key}>
                <button
                  type="button"
                  onClick={() => {
                    onChange({ preset: p.key });
                    setOpen(false);
                  }}
                  className={cn(
                    'flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-muted',
                    value.preset === p.key && 'font-medium text-primary',
                  )}
                >
                  {p.label}
                  {value.preset === p.key ? <Check className="h-4 w-4" /> : null}
                </button>
              </li>
            ))}
          </ul>

          <div className="mt-2 border-t border-border px-3 pb-2 pt-3">
            <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Custom range
            </div>
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <label htmlFor="range-from" className="w-10 text-sm text-muted-foreground">
                  From
                </label>
                <Input
                  id="range-from"
                  type="date"
                  value={draftFrom}
                  min="1990-01-01"
                  max={isValidYmd(draftTo) ? draftTo : '2099-12-31'}
                  onChange={(e) => setDraftFrom(e.target.value)}
                  className="h-9 flex-1"
                />
              </div>
              <div className="flex items-center gap-2">
                <label htmlFor="range-to" className="w-10 text-sm text-muted-foreground">
                  To
                </label>
                <Input
                  id="range-to"
                  type="date"
                  value={draftTo}
                  min={isValidYmd(draftFrom) ? draftFrom : '1990-01-01'}
                  max="2099-12-31"
                  onChange={(e) => setDraftTo(e.target.value)}
                  className="h-9 flex-1"
                />
              </div>
              {invalidDraft ? (
                <p className="text-xs text-danger">
                  {badFrom || badTo
                    ? 'Enter valid dates (4-digit year).'
                    : 'The start date must be before the end date.'}
                </p>
              ) : null}
              <Button size="sm" className="w-full" disabled={!canApply} onClick={applyCustom}>
                Apply range
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
