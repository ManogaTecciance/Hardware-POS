'use client';

import { Minus, Plus, Trash2 } from 'lucide-react';
import * as React from 'react';

import { Input } from '@/components/ui/input';
import { formatMoney } from '@/lib/restaurant/labels';

import type { DraftLine } from './pos-types';

interface Props {
  draft: DraftLine[];
  onChangeQty: (key: string, delta: number) => void;
  onRemove: (key: string) => void;
  onInstructions: (key: string, value: string) => void;
  /** Empty-state copy is mode-dependent, so the caller supplies it. */
  emptyMessage: string;
}

/**
 * The right-rail cart list — one row per draft line, with per-line qty
 * controls, a per-line instructions input, and a remove button. Totals
 * live in `PosTotals` because their composition differs by mode
 * (Takeaway has service charge, delivery has none, dine-in inherits its
 * own rules).
 */
export function PosCart({ draft, onChangeQty, onRemove, onInstructions, emptyMessage }: Props) {
  if (draft.length === 0) {
    return (
      <p className="py-6 text-center text-sm text-muted-foreground">{emptyMessage}</p>
    );
  }
  return (
    <ul className="space-y-3">
      {draft.map((r) => (
        <li key={r.key} className="rounded-lg border border-border p-3">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="text-sm font-medium">{r.name}</p>
              {r.modifiers.length > 0 ? (
                <ul className="mt-0.5 text-xs text-muted-foreground">
                  {r.modifiers.map((m) => (
                    <li key={m.optionId}>
                      + {m.optionName}
                      {Number(m.priceDelta) !== 0 ? ` (${formatMoney(m.priceDelta)})` : ''}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
            <button
              type="button"
              onClick={() => onRemove(r.key)}
              aria-label={`Remove ${r.name}`}
              className="rounded-md p-1 text-muted-foreground hover:bg-muted"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
          <div className="mt-2 flex items-center justify-between gap-2">
            <div className="inline-flex items-center gap-1">
              <QtyBtn onClick={() => onChangeQty(r.key, -1)} label="Decrease">
                <Minus className="h-4 w-4" />
              </QtyBtn>
              <span className="min-w-6 text-center text-sm font-semibold">{r.quantity}</span>
              <QtyBtn onClick={() => onChangeQty(r.key, +1)} label="Increase">
                <Plus className="h-4 w-4" />
              </QtyBtn>
            </div>
            <span className="text-sm font-semibold">
              {formatMoney(
                r.quantity *
                  (Number(r.unitPrice) +
                    r.modifiers.reduce((s, m) => s + Number(m.priceDelta), 0)),
              )}
            </span>
          </div>
          <Input
            placeholder="Special instructions"
            value={r.specialInstructions}
            onChange={(e) => onInstructions(r.key, e.target.value)}
            className="mt-2 h-9 text-sm"
          />
        </li>
      ))}
    </ul>
  );
}

function QtyBtn({
  children,
  onClick,
  label,
}: {
  children: React.ReactNode;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border text-foreground hover:bg-muted"
    >
      {children}
    </button>
  );
}
