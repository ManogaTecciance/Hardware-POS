'use client';

import { X } from 'lucide-react';
import * as React from 'react';

import { cn } from '@/lib/utils';

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  description?: string;
  children: React.ReactNode;
  /**
   * A control bar pinned between the header and the scrolling body — a search
   * box, typically.
   *
   * Here rather than as a `position: sticky` child of the body because sticky
   * only hides what passes behind its own painted box: every transparent strip
   * around it (the body's own padding, a `space-y` gap to the first row) turns
   * into a slot where rows are seen sliding past, and closing them one at a
   * time is whack-a-mole. A `shrink-0` sibling of the scroller cannot have the
   * problem — the body clips at its own edge, and there is nothing above that
   * edge to see through. The body's top padding is dropped when a toolbar is
   * present, so the first row meets the toolbar with no gap between them.
   */
  toolbar?: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
}

/**
 * Lightweight modal (overlay + centered card). Closes on Escape / overlay click.
 *
 * ## Height (D85)
 *
 * The card is capped at 80% of the viewport and lays out as a column: header
 * and footer hold their size, the BODY scrolls. Without that cap a dialog
 * grows with its content and runs off both ends of the screen — and the
 * footer goes with it, so the confirm button on a long bill or a long split
 * list is somewhere below the fold with no way to reach it.
 *
 * `dvh`, not `vh`: on a phone or an iPad in Safari the toolbar collapses and
 * expands, and `vh` measures the tallest state, which is exactly the state
 * where the dialog does not fit.
 *
 * The cap is a MAXIMUM. A short dialog is still only as tall as its content.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  toolbar,
  footer,
  className,
}: DialogProps) {
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 p-0 sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        className={cn(
          'flex max-h-[80dvh] w-full max-w-md flex-col rounded-t-2xl bg-surface shadow-xl sm:rounded-2xl',
          className,
        )}
        onClick={(e) => e.stopPropagation()}
      >
        {/* shrink-0 on the header and footer so the body is the only thing
            that gives when the content is tall. */}
        <div className="flex shrink-0 items-start justify-between gap-4 p-6 pb-2">
          <div>
            {title ? <h2 className="text-lg font-semibold tracking-tight">{title}</h2> : null}
            {description ? (
              <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>
            ) : null}
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg p-1 text-muted-foreground hover:bg-muted"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        {toolbar ? <div className="shrink-0 px-6 pb-3 pt-1">{toolbar}</div> : null}
        {/* min-h-0 is what actually lets this scroll: a flex child's default
            min-height is its content, which would push the card past the cap
            rather than overflow inside it. */}
        <div
          className={cn(
            'min-h-0 flex-1 overflow-y-auto p-6',
            // The toolbar owns the gap above the content when there is one;
            // leaving the body's own padding there would put a transparent
            // band under the toolbar for content to scroll through.
            toolbar ? 'pt-0' : 'pt-2',
          )}
        >
          {children}
        </div>
        {footer ? (
          // flex-wrap: wide button sets (long labels, formatted amounts) wrap
          // onto extra lines instead of overflowing past the card edge.
          <div className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-border p-4">
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );
}
