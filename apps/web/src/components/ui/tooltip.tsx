'use client';

import * as React from 'react';
import { createPortal } from 'react-dom';

import { cn } from '@/lib/utils';

/**
 * Lightweight tooltip: shows `label` above the wrapped element on hover and
 * keyboard focus (below it when the trigger sits near the top of the
 * viewport). Intended for icon-only buttons whose purpose isn't obvious;
 * pair with an aria-label on the button itself.
 *
 * Rendered through a portal with `position: fixed`: the previous CSS-only
 * version positioned the chip inside the trigger, so every `overflow`
 * ancestor — a table's `overflow-x-auto`, a Card's `overflow-hidden` —
 * clipped it, and action-column tooltips showed half a word.
 */

/** Matches the old CSS `delay-200`, so hover feel is unchanged. */
const SHOW_DELAY_MS = 200;
const GAP_PX = 6;
/** Roughly chip height + gap; below this much headroom the chip flips under. */
const MIN_HEADROOM_PX = 44;

interface ChipPosition {
  top: number;
  left: number;
  below: boolean;
}

export function Tooltip({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  const triggerRef = React.useRef<HTMLSpanElement>(null);
  const timerRef = React.useRef<number | null>(null);
  const [pos, setPos] = React.useState<ChipPosition | null>(null);

  const show = React.useCallback(() => {
    if (timerRef.current != null) return;
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const below = rect.top < MIN_HEADROOM_PX;
      setPos({
        top: below ? rect.bottom + GAP_PX : rect.top - GAP_PX,
        left: rect.left + rect.width / 2,
        below,
      });
    }, SHOW_DELAY_MS);
  }, []);

  const hide = React.useCallback(() => {
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setPos(null);
  }, []);

  React.useEffect(() => hide, [hide]);

  // A fixed-position chip does not follow its trigger; on any scroll or
  // resize the honest move is to dismiss rather than drift.
  React.useEffect(() => {
    if (!pos) return;
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    return () => {
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
    };
  }, [pos, hide]);

  return (
    <span
      ref={triggerRef}
      className={cn('inline-flex', className)}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocusCapture={show}
      onBlurCapture={hide}
    >
      {children}
      {pos
        ? createPortal(
            <span
              role="tooltip"
              style={{ top: pos.top, left: pos.left }}
              className={cn(
                'pointer-events-none fixed z-50 -translate-x-1/2 whitespace-nowrap',
                pos.below ? null : '-translate-y-full',
                // `foreground` on `canvas` is the page's own text/background pair
                // inverted, so the chip stays readable in both themes. A literal
                // text-white here was invisible in dark mode, where foreground IS white.
                'rounded-lg bg-foreground px-2.5 py-1 text-xs font-medium text-canvas shadow-md',
              )}
            >
              {label}
            </span>,
            document.body,
          )
        : null}
    </span>
  );
}
