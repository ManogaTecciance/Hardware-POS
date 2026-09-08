'use client';

import * as React from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

import { cn } from '@/lib/utils';

/**
 * Single-line, horizontally scrollable row of filter chips with overflow
 * affordances: the native scrollbar is hidden, a gradient fade marks each
 * edge that has more content, and chevron buttons appear on the overflowing
 * side (touch users can also just swipe). The chip marked `data-active="true"`
 * is kept scrolled into view whenever `activeKey` changes.
 */
export function ChipRow({
  activeKey,
  ariaLabel,
  className,
  children,
}: {
  /** Changes when the selection changes — used to scroll the active chip into view. */
  activeKey: string;
  ariaLabel: string;
  className?: string;
  children: React.ReactNode;
}) {
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const [canLeft, setCanLeft] = React.useState(false);
  const [canRight, setCanRight] = React.useState(false);

  const update = React.useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setCanLeft(el.scrollLeft > 4);
    setCanRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 4);
  }, []);

  React.useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.addEventListener('scroll', update, { passive: true });
    // ResizeObserver ships in every modern browser but jsdom (used by the
    // render specs) does not implement it. Guard so consumers can render
    // this primitive in a test without patching a global — the post-render
    // useEffect below still recalculates edge fades on every commit.
    const ro =
      typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null;
    ro?.observe(el);
    return () => {
      el.removeEventListener('scroll', update);
      ro?.disconnect();
    };
  }, [update]);

  // Recompute after every render: chips typically arrive AFTER mount (catalog
  // fetch), and growing content doesn't resize the container, so neither the
  // mount-time check nor the ResizeObserver sees it. setState bails when the
  // values are unchanged, so this is loop-safe.
  React.useEffect(() => {
    update();
  });

  // Keep the selected chip visible (e.g. selection restored after a reload).
  // jsdom implements Element but not `scrollIntoView`, so guard for the
  // render specs — the effect is purely cosmetic and its absence in tests
  // is fine.
  React.useEffect(() => {
    const target = scrollRef.current?.querySelector('[data-active="true"]');
    if (target && typeof (target as Element & { scrollIntoView?: unknown }).scrollIntoView === 'function') {
      (target as HTMLElement).scrollIntoView({
        inline: 'nearest',
        block: 'nearest',
        behavior: 'smooth',
      });
    }
  }, [activeKey]);

  const nudge = (dir: 1 | -1) => {
    const el = scrollRef.current;
    if (el) el.scrollBy({ left: dir * el.clientWidth * 0.7, behavior: 'smooth' });
  };

  return (
    <div className={cn('relative', className)}>
      <div
        ref={scrollRef}
        role="group"
        aria-label={ariaLabel}
        className="flex gap-2 overflow-x-auto scroll-smooth [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {children}
      </div>

      {canLeft ? (
        <>
          <div className="pointer-events-none absolute inset-y-0 left-0 w-12 bg-gradient-to-r from-canvas to-transparent" />
          <button
            type="button"
            aria-label={`Scroll ${ariaLabel} left`}
            onClick={() => nudge(-1)}
            className="absolute left-0 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full border border-border bg-surface shadow-sm transition-colors hover:bg-muted"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
        </>
      ) : null}

      {canRight ? (
        <>
          <div className="pointer-events-none absolute inset-y-0 right-0 w-12 bg-gradient-to-l from-canvas to-transparent" />
          <button
            type="button"
            aria-label={`Scroll ${ariaLabel} right`}
            onClick={() => nudge(1)}
            className="absolute right-0 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full border border-border bg-surface shadow-sm transition-colors hover:bg-muted"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </>
      ) : null}
    </div>
  );
}
