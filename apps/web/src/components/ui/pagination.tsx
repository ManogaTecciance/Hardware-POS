'use client';

import * as React from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

import { Select } from '@/components/ui/select';
import { cn } from '@/lib/utils';

/**
 * The rows-per-page choices, everywhere (PO, 2026-09-09).
 *
 * One list, three steps: a screenful, a scan, and a bulk look. It replaced
 * three different lists that had drifted apart — the shared 10/20/30/50, the
 * till's 20/30/40/50 and the orders queue's 25/50/75/100 — so the same control
 * offered different numbers depending on which screen it sat on.
 *
 * The first entry is also the DEFAULT every list starts on, so it must stay
 * the smallest: a screen defaulting to a size not in this list shows a
 * rows-per-page control that disagrees with the page it is on.
 */
export const PAGE_SIZES = [20, 50, 100];

/** How many numbered buttons before the list starts collapsing behind ellipses. */
const MAX_SLOTS = 7;

/**
 * The page numbers to render, with `null` standing for a gap.
 *
 * Always keeps the first and last page reachable and the current page centred,
 * so the row neither jumps in width nor loses the ends when there are many
 * pages: 1 … 5 6 7 … 42.
 */
export function pageWindow(page: number, pages: number): (number | null)[] {
  if (pages <= MAX_SLOTS) return Array.from({ length: pages }, (_, i) => i + 1);

  const slots = new Set<number>([1, pages, page]);
  slots.add(Math.max(1, page - 1));
  slots.add(Math.min(pages, page + 1));
  // Near an end there is no gap to fill, so spend the freed slots on that side
  // rather than leaving the row short.
  if (page <= 3) [2, 3, 4].forEach((n) => slots.add(n));
  if (page >= pages - 2) [pages - 3, pages - 2, pages - 1].forEach((n) => slots.add(n));

  const sorted = [...slots].filter((n) => n >= 1 && n <= pages).sort((a, b) => a - b);
  const out: (number | null)[] = [];
  sorted.forEach((n, i) => {
    const prev = sorted[i - 1];
    if (prev !== undefined && n - prev > 1) out.push(null);
    out.push(n);
  });
  return out;
}

/**
 * The table footer used everywhere in the app: rows per page, the visible range,
 * and numbered pages.
 *
 * Numbered rather than just back/forward, because "page 6 of 42" is a place you
 * can go to directly and come back to; stepping one at a time is not.
 */
export function Pagination({
  page,
  pageSize,
  total,
  onPageChange,
  onPageSizeChange,
  pageSizes = PAGE_SIZES,
  disabled = false,
  className,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  /** Omit to hide the rows-per-page control, for a list with a fixed size. */
  onPageSizeChange?: (pageSize: number) => void;
  pageSizes?: number[];
  disabled?: boolean;
  className?: string;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(Math.max(1, page), pages);
  const from = total === 0 ? 0 : (current - 1) * pageSize + 1;
  const to = Math.min(current * pageSize, total);

  const go = (n: number) => {
    const next = Math.min(Math.max(1, n), pages);
    if (next !== current) onPageChange(next);
  };

  return (
    <div
      className={cn(
        'flex flex-wrap items-center justify-between gap-3 text-sm',
        className,
      )}
    >
      {onPageSizeChange ? (
        <div className="flex items-center gap-2 text-muted-foreground">
          <span>Rows per page</span>
          <Select
            value={String(pageSize)}
            onChange={(e) => onPageSizeChange(Number(e.target.value))}
            className="w-auto"
            disabled={disabled}
            /* The words beside it are a plain span, not a <label>, so without
               this a screen reader announces an unnamed combobox on every list
               in the product. The orders queue's own copy of this control has
               always carried the name; the shared one had not. */
            aria-label="Rows per page"
          >
            {pageSizes.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </Select>
        </div>
      ) : (
        <span />
      )}

      <div className="flex flex-wrap items-center gap-3">
        <span className="text-muted-foreground">
          {total === 0 ? '0' : `${from}–${to}`} of {total}
        </span>
        <nav className="flex items-center gap-1" aria-label="Pagination">
          <PageButton
            onClick={() => go(current - 1)}
            disabled={disabled || current <= 1}
            label="Previous page"
          >
            <ChevronLeft className="h-4 w-4" />
          </PageButton>

          {pageWindow(current, pages).map((n, i) =>
            n === null ? (
              <span
                key={`gap-${i}`}
                className="px-1 text-muted-foreground"
                aria-hidden
              >
                …
              </span>
            ) : (
              <PageButton
                key={n}
                onClick={() => go(n)}
                disabled={disabled}
                active={n === current}
                label={`Page ${n}`}
              >
                {n}
              </PageButton>
            ),
          )}

          <PageButton
            onClick={() => go(current + 1)}
            disabled={disabled || current >= pages}
            label="Next page"
          >
            <ChevronRight className="h-4 w-4" />
          </PageButton>
        </nav>
      </div>
    </div>
  );
}

function PageButton({
  children,
  onClick,
  disabled,
  active,
  label,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'inline-flex h-8 min-w-8 items-center justify-center rounded-lg border px-2 text-sm font-medium transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        'disabled:cursor-not-allowed disabled:opacity-50',
        active
          ? 'border-primary bg-primary text-primary-foreground'
          : 'border-border text-muted-foreground hover:bg-muted hover:text-foreground',
      )}
    >
      {children}
    </button>
  );
}
