'use client';

import * as React from 'react';
import { createPortal } from 'react-dom';

import { cn } from '@/lib/utils';

/** Space between the trigger and the bubble, and from the viewport edge. */
const GAP = 6;
const EDGE = 8;
const DELAY_MS = 200;

interface Position {
  top: number;
  left: number;
  /** Below the trigger when there is no room above; the arrow-less bubble just moves. */
  below: boolean;
}

/**
 * Lightweight tooltip: shows `label` on hover and keyboard focus.
 *
 * The bubble is rendered into `document.body` rather than beside the trigger.
 * Every table in this app sits inside `overflow-hidden` (the Card) and
 * `overflow-x-auto` (the scroll container), and an absolutely-positioned child
 * is CLIPPED by those — a z-index cannot lift anything out of an overflow box.
 * Portalling to the body escapes that, and every ancestor stacking context with
 * it, so a tooltip on a table row is no longer trimmed to its cell.
 *
 * Positioned on show and re-measured while visible, since the page can scroll
 * under it. Fixed coordinates, so they are viewport coordinates and need no
 * scroll offset.
 */
export function Tooltip({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  const triggerRef = React.useRef<HTMLSpanElement | null>(null);
  const timer = React.useRef<number | null>(null);
  const [position, setPosition] = React.useState<Position | null>(null);
  // Portals need a DOM; on the server there is none, so nothing renders until mount.
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);

  const measure = React.useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    // Above by default; below when the top of the viewport is in the way.
    const below = r.top < 44;
    setPosition({
      top: below ? r.bottom + GAP : r.top - GAP,
      left: Math.min(Math.max(r.left + r.width / 2, EDGE), window.innerWidth - EDGE),
      below,
    });
  }, []);

  const show = React.useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(measure, DELAY_MS);
  }, [measure]);

  const hide = React.useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    setPosition(null);
  }, []);

  // Clear a pending timer if the trigger goes away mid-delay.
  React.useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);

  // While it is up, follow the trigger and let Escape dismiss it.
  React.useEffect(() => {
    if (!position) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && hide();
    // Capture, so scrolling any ancestor — not just the window — is caught.
    window.addEventListener('scroll', measure, true);
    window.addEventListener('resize', measure);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('scroll', measure, true);
      window.removeEventListener('resize', measure);
      window.removeEventListener('keydown', onKey);
    };
  }, [position, measure, hide]);

  return (
    <span
      ref={triggerRef}
      className={cn('relative inline-flex', className)}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocusCapture={show}
      onBlurCapture={hide}
    >
      {children}
      {mounted && position
        ? createPortal(
            <span
              role="tooltip"
              style={{
                position: 'fixed',
                top: position.top,
                left: position.left,
                transform: position.below ? 'translateX(-50%)' : 'translate(-50%, -100%)',
              }}
              className={cn(
                // Never wider than the viewport: the bubble is centred on the
                // trigger, so one near an edge would otherwise hang off it.
                'pointer-events-none z-[100] max-w-[min(20rem,calc(100vw-1rem))]',
                'whitespace-normal text-balance',
                // `foreground` on `canvas` is the page's own text/background pair
                // inverted, so the chip stays readable in both themes.
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
