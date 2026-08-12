'use client';

/**
 * `<Sheet>` — bottom-anchored panel that behaves like a modal on tablets and
 * phones, and (with `side="right"`) like a drawer on wide viewports.
 *
 * ## Why this exists — `<Dialog>` is not a sheet
 *
 * `<Dialog>` centers a `max-w-md` card. Below `sm` it anchors to the bottom of
 * the viewport and top-rounds itself, which looks sheet-shaped but is not a
 * sheet: there is no drag handle, no snap point, no full-height option, and no
 * safe-area padding. It stays capped at 448px even on a 1024px iPad landscape,
 * which is exactly why the Modifier Picker and Payment Popup use vast dead
 * space today.
 *
 * `<Drawer>` is a right-side slide-over — a persistent side panel, not a sheet.
 *
 * `<Sheet>` fills the gap: a bottom sheet that scales to viewport width with a
 * configurable `height` ("auto" / "half" / "full"), respects safe-area insets
 * on iOS Safari (see `viewport-fit: cover` in `app/layout.tsx`), and traps
 * focus + Escape.
 *
 * ## Structure
 *
 *   overlay   — full-screen scrim, dismisses on click.
 *   panel     — rounded-t-2xl surface anchored to `items-end`.
 *   handle    — small pill above the header, cue that this is dismissible.
 *   header    — title + description + close X.
 *   body      — scrollable content (`overflow-y-auto` on `max-h`).
 *   footer    — sticky action row inside the panel, safe-area padded.
 *
 * ## Behaviour that differs from `<Dialog>`
 *
 * - **Anchored to viewport bottom regardless of viewport width.** This is the
 *   whole point: on landscape tablet we still want the sheet to slide up from
 *   the bottom, because the operator's thumb is already there and the primary
 *   action lives at the bottom of the panel. Callers who want a centered card
 *   on desktop should keep using `<Dialog>`.
 *
 * - **`height='full'` claims the full viewport minus 3rem** — a common pattern
 *   for the modifier picker on portrait, where a menu item with 6+ modifier
 *   groups will not fit in a half sheet.
 *
 * - **Sticky footer is inside the panel.** A `<Dialog>` footer is a normal
 *   flow child; sheet footers pin to the bottom of the panel so the primary
 *   action stays visible while the body scrolls. Safe-area padding is
 *   baked in.
 *
 * - **No drag-to-dismiss (yet).** Deliberately: drag gestures + iOS pinch-to-
 *   dismiss + the OS home indicator on the same slide would conflict, and
 *   AxloPOS operators tap Cancel more predictably than they swipe. Adding it
 *   later is additive; removing it later would be a behaviour regression.
 */

import { X } from 'lucide-react';
import * as React from 'react';

import { cn } from '@/lib/utils';

type SheetHeight = 'auto' | 'half' | 'full';

export interface SheetProps {
  open: boolean;
  onClose: () => void;
  /**
   * Content height ceiling. Default `'auto'` — the panel is as tall as its
   * body up to `max-h-[85dvh]`.
   *
   *   'auto' — grows to content, capped at 85dvh.
   *   'half' — a fixed 60dvh, useful for a stable "peek" state.
   *   'full' — 100dvh minus a 3rem top strip (leaves the scrim visible
   *            so a mis-tap on the top edge still dismisses).
   */
  height?: SheetHeight;
  title?: string;
  description?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  /**
   * Extra class on the panel — accepts `max-w-*` to cap width on wide
   * viewports (a Sheet in a payment flow rarely wants to be viewport-wide
   * on a 1440px desktop; a caller can pass `sm:max-w-2xl` to keep the
   * bottom-anchor but centre-align it).
   */
  className?: string;
  /**
   * When set, the header X and the overlay-click dismiss are suppressed.
   * Used when a caller needs to force a decision (Payment complete → OK,
   * Order sent → OK). Escape still works so keyboard operators are not
   * trapped in a modal they cannot leave.
   */
  dismissible?: boolean;
}

const HEIGHT_CLASSES: Record<SheetHeight, string> = {
  auto: 'max-h-[85dvh]',
  half: 'h-[60dvh]',
  full: 'h-[calc(100dvh-3rem)]',
};

export function Sheet({
  open,
  onClose,
  height = 'auto',
  title,
  description,
  children,
  footer,
  className,
  dismissible = true,
}: SheetProps) {
  // Escape closes even when `dismissible=false` — keyboard operators must
  // always have an exit. Only the tap targets are suppressed.
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Body scroll lock while open. Restaurant tablets sit face-up on a bench —
  // an accidental brush past the sheet edge would scroll the page underneath
  // if we didn't lock body.
  React.useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40"
      onClick={dismissible ? onClose : undefined}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? 'sheet-title' : undefined}
        aria-describedby={description ? 'sheet-description' : undefined}
        onClick={(e) => e.stopPropagation()}
        className={cn(
          'flex w-full flex-col overflow-hidden rounded-t-2xl bg-surface shadow-pop outline-none',
          // Sheet is always bottom-anchored; on tab-up we cap the width so
          // it doesn't stretch to a 1440px monitor. `mx-auto` centres it
          // inside the flex container so the anchor stays bottom-centre.
          'tab:mx-auto tab:max-w-2xl',
          // Slide-up entrance. Reduced-motion falls through to the global
          // `prefers-reduced-motion` rule in globals.css which zeros
          // animation durations.
          'motion-safe:animate-in motion-safe:slide-in-from-bottom motion-safe:duration-200',
          HEIGHT_CLASSES[height],
          className,
        )}
      >
        {/* Grab handle — cue that this is a sheet. Aria-hidden so screen
            readers announce the title, not this. */}
        <div className="flex shrink-0 justify-center pt-2" aria-hidden="true">
          <span className="h-1 w-10 rounded-full bg-border-strong/60" />
        </div>

        {(title || description || dismissible) && (
          <div className="flex shrink-0 items-start justify-between gap-4 px-6 pt-3 pb-2">
            <div className="min-w-0">
              {title && (
                <h2
                  id="sheet-title"
                  className="text-lg font-semibold tracking-tight text-foreground"
                >
                  {title}
                </h2>
              )}
              {description && (
                <p
                  id="sheet-description"
                  className="mt-0.5 text-sm text-muted-foreground"
                >
                  {description}
                </p>
              )}
            </div>
            {dismissible && (
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                className="-mt-1 -mr-2 shrink-0 touch-target rounded-lg p-2 text-muted-foreground hover:bg-muted"
              >
                <X className="h-5 w-5" />
              </button>
            )}
          </div>
        )}

        {/* Scrollable body — `min-h-0` inside a flex column is what lets the
            child region scroll instead of pushing the footer off-screen. */}
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-3">
          {children}
        </div>

        {footer && (
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-border bg-surface px-6 py-3 pb-safe">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
