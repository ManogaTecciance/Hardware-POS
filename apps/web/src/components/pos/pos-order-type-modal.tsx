'use client';

import { ShoppingBag, Truck, UtensilsCrossed, X } from 'lucide-react';
import * as React from 'react';

import type { PosMode } from './pos-mode-selector';

interface Props {
  onSelect: (mode: PosMode) => void;
  onCancel: () => void;
}

interface Option {
  mode: PosMode;
  title: string;
  hint: string;
  icon: React.ReactNode;
}

const OPTIONS: readonly Option[] = [
  {
    mode: 'DINE_IN',
    title: 'Dine In',
    hint: 'Waiter takes the order at a table. Items appear on the kitchen board as they are added; the bill is raised when the order is completed.',
    icon: <UtensilsCrossed className="h-6 w-6" />,
  },
  {
    mode: 'TAKEAWAY',
    title: 'Takeaway',
    hint: 'Guest orders now, picks up soon. Payment on completion.',
    icon: <ShoppingBag className="h-6 w-6" />,
  },
  {
    mode: 'THIRD_PARTY',
    title: 'Delivery',
    hint: 'Order goes to a rider. Payment usually on delivery.',
    icon: <Truck className="h-6 w-6" />,
  },
];

/**
 * The very first thing a cashier sees when they open the counter POS.
 *
 * One click on a card selects the mode and opens the workspace — no
 * Continue button, no second confirmation, no wasted taps. Escape or the
 * X cancels back to wherever the operator came from (usually /dashboard
 * or /orders).
 *
 * NOT a viewport modal (PO request, 2026-08-17): the old full-screen
 * Dialog dimmed the sidebar and header too, which read as the whole app
 * being locked. This chooser is the page's only content, so it renders as
 * a centred panel INSIDE the content area — the navigation stays visible
 * and usable, and walking away is just clicking any nav item.
 *
 * Keyboard: Arrow-Up/Down move focus, Enter selects. `role="radiogroup"`
 * on the container so a screen reader announces "3 of 3, radio" for the
 * final option.
 */
export function PosOrderTypeModal({ onSelect, onCancel }: Props) {
  const [focusIdx, setFocusIdx] = React.useState(0);
  const buttonRefs = React.useRef<Array<HTMLButtonElement | null>>([]);

  React.useEffect(() => {
    buttonRefs.current[focusIdx]?.focus();
  }, [focusIdx]);

  const onKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
      e.preventDefault();
      setFocusIdx((i) => (i - 1 + OPTIONS.length) % OPTIONS.length);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
      e.preventDefault();
      setFocusIdx((i) => (i + 1) % OPTIONS.length);
    }
  };

  // Escape still cancels, exactly as the old dialog did.
  React.useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onCancel();
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onCancel]);

  return (
    <div className="flex min-h-[70svh] w-full items-center justify-center">
      <div
        role="dialog"
        aria-label="Start new order"
        className="w-full max-w-2xl rounded-2xl border border-border bg-surface p-6 shadow-pop"
      >
        <div className="flex items-start justify-between gap-4 pb-4">
          <div>
            <h2 className="text-lg font-semibold tracking-tight">Start new order</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">How will this order be served?</p>
          </div>
          <button
            onClick={onCancel}
            aria-label="Close"
            className="rounded-lg p-1 text-muted-foreground hover:bg-muted"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
      <div
        role="radiogroup"
        aria-label="Order type"
        onKeyDown={onKey}
        className="grid grid-cols-1 gap-2 sm:grid-cols-3"
      >
        {OPTIONS.map((o, i) => (
          <button
            key={o.mode}
            ref={(el) => {
              buttonRefs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={false}
            tabIndex={i === focusIdx ? 0 : -1}
            onClick={() => onSelect(o.mode)}
            className="group flex flex-col items-start gap-2 rounded-xl border border-border bg-card p-4 text-left transition-all hover:border-primary hover:bg-brand-100 focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 active:scale-[0.99]"
          >
            <div className="rounded-lg bg-primary/12 p-2 text-primary group-hover:bg-primary/20">
              {o.icon}
            </div>
            <span className="text-base font-semibold">{o.title}</span>
            <span className="text-xs text-muted-foreground">{o.hint}</span>
          </button>
        ))}
      </div>
        <p className="mt-3 text-xs text-muted-foreground">
          You can change the mode later from the POS header — as long as the cart is empty
          or the change is safe.
        </p>
      </div>
    </div>
  );
}
