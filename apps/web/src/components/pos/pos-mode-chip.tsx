'use client';

import { ShoppingBag, Truck, UtensilsCrossed } from 'lucide-react';
import * as React from 'react';

import type { PosMode } from './pos-mode-selector';

const ICONS: Record<PosMode, React.ReactNode> = {
  DINE_IN: <UtensilsCrossed className="h-4 w-4" />,
  TAKEAWAY: <ShoppingBag className="h-4 w-4" />,
  THIRD_PARTY: <Truck className="h-4 w-4" />,
};

const LABELS: Record<PosMode, string> = {
  DINE_IN: 'Dine In',
  TAKEAWAY: 'Takeaway',
  THIRD_PARTY: 'Delivery',
};

interface Props {
  mode: PosMode;
  onChange: () => void;
  disabled?: boolean;
  disabledReason?: string;
}

/**
 * The compact one-line indicator that replaces the persistent segmented
 * control on the POS header (Section 1 of the counter-POS spec). Clicking
 * "Change" re-opens the Order Type modal; disabled with a reason when
 * changing mode would invalidate the current cart (taxes, service charge,
 * delivery address, etc.).
 */
export function PosModeChip({ mode, onChange, disabled, disabledReason }: Props) {
  return (
    <div
      className="inline-flex items-center gap-2 rounded-full border border-border bg-surface px-3 py-1.5"
      role="group"
      aria-label={`Order mode: ${LABELS[mode]}`}
    >
      <span className="text-primary" aria-hidden="true">
        {ICONS[mode]}
      </span>
      <span className="text-sm font-semibold">{LABELS[mode]}</span>
      <span className="text-xs text-muted-foreground">·</span>
      <button
        type="button"
        onClick={onChange}
        disabled={disabled}
        title={disabled ? disabledReason : 'Change order type'}
        className="text-xs font-medium text-primary transition-colors hover:text-primary/80 disabled:cursor-not-allowed disabled:text-muted-foreground"
      >
        Change
      </button>
    </div>
  );
}
