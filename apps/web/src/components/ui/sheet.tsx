'use client';

/**
 * `<Sheet>` — the app's wide popup panel. Centred, like every other modal.
 *
 * ## What it is, and why it is not `<Dialog>`
 *
 * `<Dialog>` is a `max-w-md` card: the right shape for a question. It stays
 * capped at 448px even on a 1024px iPad landscape, which is why the modifier
 * picker and the payment popup needed something else — they are WORKING
 * surfaces, not questions, and they want the width.
 *
 * `<Sheet>` is that: a panel that scales to the viewport with a configurable
 * `height` ("auto" / "half" / "full"), a body that scrolls, and a sticky
 * footer that keeps the primary action visible while it does. `<Drawer>` is a
 * different thing again — a right-side slide-over, a persistent side panel.
 *
 * ## It used to be a bottom sheet, and is not any more (PO, 2026-09-09)
 *
 * Everything below the header used to be anchored to `items-end`: the panel
 * sat against the bottom edge at every width, on the reasoning that the
 * operator's thumb is already there. The product owner's rule is that a popup
 * belongs in the MIDDLE of the screen wherever it is read — reported against
 * the dine-in bill, which filled the window from top to bottom with the scrim
 * showing only above it.
 *
 * Three things went with the anchor, because each of them only made sense
 * while the panel touched the bottom edge:
 *
 *   - the grab handle, a cue for a pull gesture that no longer applies;
 *   - `rounded-t-2xl`, which was right only while the bottom corners were
 *     off-screen;
 *   - `pb-safe` on the footer, which measured an inset the panel no longer
 *     reaches.
 *
 * The slide-up entrance became a grow-in for the same reason: a panel that
 * rises from the bottom edge and halts in the middle looks like an animation
 * that failed.
 *
 * The NAME is now a small lie — this is a centred panel, not a sheet. It is
 * kept because renaming it touches eleven call sites for no behavioural gain;
 * recorded here rather than left for someone to discover.
 *
 * ## Structure
 *
 *   overlay   — full-screen scrim, centred, `p-4` so the panel clears the
 *               screen edges; dismisses on click.
 *   panel     — rounded surface, width-capped from `tab` up.
 *   header    — title + description + close X.
 *   body      — scrollable content (`overflow-y-auto`, `min-h-0`).
 *   footer    — sticky action row inside the panel.
 *
 * ## Behaviour that still differs from `<Dialog>`
 *
 * - **Width.** `<Dialog>` is `max-w-md`; a Sheet scales and caps at
 *   `tab:max-w-2xl`, and a caller can widen it further.
 *
 * - **`height`.** A Dialog is as tall as its content under an 80dvh cap. A
 *   Sheet can also claim a FIXED 60dvh or 80dvh, so a modifier picker does
 *   not resize as groups expand.
 *
 * - **`height='full'` claims 80dvh** (D85) — the tallest any popup surface
 *   goes; the body scrolls beyond that rather than the panel growing.
 *
 * - **Sticky footer.** A `<Dialog>` footer is a normal flow child; a Sheet
 *   footer pins to the bottom of the panel so the primary action stays
 *   visible while the body scrolls.
 *
 * - **Body scroll lock.** Restaurant tablets sit face-up on a bench, where a
 *   brush past the panel edge would otherwise scroll the page underneath.
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
   * body up to `max-h-[80dvh]`.
   *
   *   'auto' — grows to content, capped at 80dvh.
   *   'half' — a fixed 60dvh, useful for a stable "peek" state.
   *   'full' — 80dvh (leaves the scrim visible
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
  /*
   * D85 — 80dvh is the ceiling for every popup surface, sheets included, so
   * one rule holds across the app rather than each control having its own
   * idea of "tall". `full` used to claim the viewport minus a 3rem strip;
   * on a phone that left the sheet's own footer pressed against the home
   * indicator, and it broke the rule for no benefit a bottom sheet needs.
   */
  auto: 'max-h-[80dvh]',
  half: 'h-[60dvh]',
  full: 'h-[80dvh]',
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
      /*
       * CENTRED, at every width (PO, 2026-09-09). This was `items-end`, which
       * is what made the bill panel sit against the bottom of the window with
       * the scrim only above it. The instruction covers every popup surface,
       * not just `<Dialog>`, so it applies here too.
       *
       * `p-4` so a panel that is nearly as tall as its 80dvh ceiling still
       * floats clear of both edges instead of touching them.
       */
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
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
          // Rounded on all four corners now that it floats: `rounded-t-2xl`
          // was right only while the bottom two were off-screen.
          'flex w-full flex-col overflow-hidden rounded-2xl bg-surface shadow-pop outline-none',
          // Width is still capped on wide viewports so the panel does not
          // stretch across a 1440px monitor.
          'tab:mx-auto tab:max-w-2xl',
          // Grow-in rather than slide-up: a panel that rises from the bottom
          // edge and stops in the middle reads as an animation that did not
          // finish. Reduced-motion falls through to the global
          // `prefers-reduced-motion` rule in globals.css, which zeros
          // animation durations.
          'motion-safe:animate-in motion-safe:fade-in motion-safe:zoom-in-95 motion-safe:duration-200',
          HEIGHT_CLASSES[height],
          className,
        )}
      >
        {/* The grab handle is gone with the bottom anchor. It was the cue that
            the panel could be pulled from the edge of the screen; on a card
            floating in the middle it points at a gesture that does not exist,
            and it read as an unfinished drag affordance. */}
        {(title || description || dismissible) && (
          <div className="flex shrink-0 items-start justify-between gap-4 px-6 pt-5 pb-2">
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

        {/* `pb-safe` went with the bottom anchor: the panel no longer reaches
            the home indicator, so an inset that still measured it just added
            stray padding under the actions on iOS. */}
        {footer && (
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-border bg-surface px-6 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
