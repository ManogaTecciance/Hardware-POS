'use client';

/**
 * The weight/measure numpad — D113 (`6.3`).
 *
 * A cashier reads an amount off an ordinary offline scale and types it here.
 * There is no device integration and no scale driver: D113's whole argument is
 * that the shop already owns a scale and the cashier can already read it, so the
 * system's job is to accept the number rather than to acquire it.
 *
 * ## What this component does NOT do
 *
 * **It does not compute a price.** It collects a quantity and hands it back.
 * `0.750 × 200` looks too simple to centralise, and that is exactly how `2.12`
 * (four sale-line renderers, two of them fixed) and `3.10` (the till quoting 18%
 * on an item the server zero-rated) happened. One money engine (D59) — the line
 * total comes from the same place every other line total comes from.
 *
 * The running total shown below the keypad is a PREVIEW, computed by the caller
 * from the cart's own rule, not by this component.
 */

import * as React from 'react';
import { Delete } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';

/** The most a `Decimal(12,3)` column can hold — grams (D113b §3). */
const MAX_DECIMALS = 3;

export interface MeasureNumpadProps {
  open: boolean;
  /** "Rice (Red / Samba)" — what is being weighed. */
  label: string;
  /** "kg". Never blank for a measured product: D113c makes the server refuse one. */
  unit: string;
  /**
   * The quantity already on this line, when the cashier is re-entering it.
   * The keypad opens pre-filled and the value typed REPLACES it — an absolute
   * amount, never an increment, because "add 0.3 to what is there" and "make it
   * 0.3" look identical on a keypad and only one can be right.
   */
  initialQuantity?: number;
  /** Available stock, when the tenant tracks it. Entry above this is refused. */
  max?: number;
  /** Rendered under the keypad, e.g. `Rs 150.00`. Computed by the CALLER. */
  preview?: (quantity: number) => string;
  onConfirm: (quantity: number) => void;
  onCancel: () => void;
}

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0'] as const;

/**
 * What is typed, as a string — so a trailing `.` survives mid-entry.
 *
 * Exported for its own test: the keypad's rules are a pure string function, and
 * proving them through a rendered dialog would cost more and show less.
 */
export function appendKey(current: string, key: string): string {
  if (key === '.') {
    // One decimal point, and `.5` starts as `0.`, which is what a cashier means.
    if (current.includes('.')) return current;
    return current === '' ? '0.' : `${current}.`;
  }
  if (current === '0') return key;
  const next = `${current}${key}`;
  const [, fraction] = next.split('.');
  // D113b §3 — a fourth place is silently truncated by the database, so it is
  // refused where the operator can still see it.
  if (fraction !== undefined && fraction.length > MAX_DECIMALS) return current;
  return next;
}

export function MeasureNumpad({
  open,
  label,
  unit,
  initialQuantity,
  max,
  preview,
  onConfirm,
  onCancel,
}: MeasureNumpadProps) {
  const [typed, setTyped] = React.useState('');

  // Re-seed whenever the dialog opens for a different line. A stale value from
  // the last item is the one mistake this component could make that a cashier
  // would not notice.
  React.useEffect(() => {
    if (open) setTyped(initialQuantity ? String(initialQuantity) : '');
  }, [open, initialQuantity, label]);

  const quantity = Number(typed);
  const parsed = typed !== '' && Number.isFinite(quantity) ? quantity : null;

  const overStock = parsed !== null && max !== undefined && parsed > max;
  // `0` is refused HERE, not only by the server's `@IsPositive()` — the cashier
  // finds out while they can still fix it (D113).
  const valid = parsed !== null && parsed > 0 && !overStock;

  const confirm = () => {
    if (!valid || parsed === null) return;
    onConfirm(parsed);
  };

  return (
    <Dialog open={open} onClose={onCancel} title={`How many ${unit}?`}>
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">{label}</p>

        <div className="rounded-lg border border-border bg-muted px-4 py-3 text-right">
          <span className="text-3xl font-semibold tabular-nums">{typed || '0'}</span>
          <span className="ml-2 text-lg text-muted-foreground">{unit}</span>
        </div>

        {overStock ? (
          <p className="text-sm text-danger">
            Only {max} {unit} in stock.
          </p>
        ) : preview && valid && parsed !== null ? (
          <p className="text-sm text-muted-foreground">
            Line total: <span className="font-medium text-foreground">{preview(parsed)}</span>
          </p>
        ) : (
          // Height held so the keypad does not jump as the message appears.
          <p className="text-sm">&nbsp;</p>
        )}

        <div className="grid grid-cols-3 gap-2">
          {KEYS.map((key) => (
            <Button
              key={key}
              variant="outline"
              className="h-14 text-xl"
              onClick={() => setTyped((c) => appendKey(c, key))}
            >
              {key}
            </Button>
          ))}
          <Button
            variant="outline"
            className="h-14"
            aria-label="Delete last digit"
            onClick={() => setTyped((c) => c.slice(0, -1))}
          >
            <Delete className="h-5 w-5" />
          </Button>
        </div>

        <div className="flex gap-2">
          {/* Cancel adds NOTHING. A half-added line is worse than no line (D113). */}
          <Button variant="outline" className="flex-1" onClick={onCancel}>
            Cancel
          </Button>
          <Button className="flex-1" disabled={!valid} onClick={confirm}>
            Add
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
