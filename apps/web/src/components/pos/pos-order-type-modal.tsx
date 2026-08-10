'use client';

import { ShoppingBag, Truck, UtensilsCrossed } from 'lucide-react';
import * as React from 'react';

import { Dialog } from '@/components/ui/dialog';

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
    hint: 'Guest is at the counter — payment collected now, no table.',
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
 * dialog backdrop cancels back to wherever the operator came from
 * (usually /dashboard or /orders).
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

  return (
    <Dialog
      open
      onClose={onCancel}
      title="Start new order"
      description="How will this order be served?"
    >
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
    </Dialog>
  );
}
