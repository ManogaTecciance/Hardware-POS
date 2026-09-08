'use client';

import { ShoppingBag, Truck, UtensilsCrossed } from 'lucide-react';
import * as React from 'react';

/**
 * The three POS modes. Mirrored on the server as `RestaurantOrderChannel`
 * (DINE_IN, TAKEAWAY, ONLINE — where ONLINE is the internal name for
 * THIRD_PARTY per PO decision 1).
 */
export type PosMode = 'DINE_IN' | 'TAKEAWAY' | 'THIRD_PARTY';

interface Props {
  value: PosMode;
  onChange: (mode: PosMode) => void;
}

/**
 * Segmented control for the mode switch. `role="radiogroup"` + `aria-checked`
 * so a keyboard/screen-reader user reads it the same way a sighted user
 * clicks it. Left-right arrow keys move focus + selection.
 */
export function PosModeSelector({ value, onChange }: Props) {
  const options: { key: PosMode; label: string; icon: React.ReactNode }[] = [
    { key: 'DINE_IN', label: 'Dine In', icon: <UtensilsCrossed className="h-4 w-4" /> },
    { key: 'TAKEAWAY', label: 'Takeaway', icon: <ShoppingBag className="h-4 w-4" /> },
    { key: 'THIRD_PARTY', label: '3rd Party', icon: <Truck className="h-4 w-4" /> },
  ];
  const idx = options.findIndex((o) => o.key === value);

  const onKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const delta = e.key === 'ArrowLeft' ? -1 : 1;
    const next = options[(idx + delta + options.length) % options.length];
    if (next) onChange(next.key);
  };

  return (
    <div
      role="radiogroup"
      aria-label="Order mode"
      onKeyDown={onKey}
      className="inline-flex gap-1 rounded-xl border border-border bg-muted/40 p-1"
    >
      {options.map((o) => {
        const active = o.key === value;
        return (
          <button
            key={o.key}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(o.key)}
            className={`inline-flex h-9 items-center gap-2 rounded-lg px-4 text-sm font-medium transition-colors ${
              active
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground'
            }`}
          >
            {o.icon}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
