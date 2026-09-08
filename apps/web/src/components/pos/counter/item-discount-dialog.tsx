'use client';

import { AlertTriangle, ShieldCheck } from 'lucide-react';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { withinDiscountLimit } from '@/lib/permissions';
import { formatMoney } from '@/lib/restaurant/labels';

import type { DraftLine } from '../pos-types';

export interface LineDiscount {
  type: 'PERCENTAGE' | 'FIXED';
  value: number;
  reason?: string;
  approvalToken?: string;
  approvedByUserId?: string;
}

interface Props {
  line: DraftLine;
  /** Discount limit % for the current user's role. `null` = unlimited. */
  roleLimit: number | null;
  onApply: (discount: LineDiscount | null) => void;
  onClose: () => void;
}

const REASONS = [
  'Staff promotion',
  'Manager comp',
  'Loyalty reward',
  'Service recovery',
  'Damaged item',
  'Other',
] as const;

/**
 * Per-line discount dialog. Two types — percentage or fixed amount —
 * with a reason and an optional note. When the entered percent exceeds
 * the cashier's role limit, the dialog surfaces a manager-approval
 * warning; for the pilot the token capture is a follow-up. The dialog
 * refuses to apply an over-limit discount without approval, matching
 * the "silently apply" prohibition in Section 9.
 */
export function ItemDiscountDialog({ line, roleLimit, onApply, onClose }: Props) {
  const unitWithMods =
    Number(line.unitPrice) + line.modifiers.reduce((s, m) => s + Number(m.priceDelta), 0);
  const lineSubtotal = line.quantity * unitWithMods;

  const [type, setType] = React.useState<'PERCENTAGE' | 'FIXED'>(line.discount?.type ?? 'PERCENTAGE');
  const [value, setValue] = React.useState(String(line.discount?.value ?? ''));
  const [reason, setReason] = React.useState(line.discount?.reason ?? REASONS[0]);
  const [note, setNote] = React.useState('');

  const numValue = Number(value);
  const isNum = !Number.isNaN(numValue) && numValue > 0;
  const percentEquivalent = isNum
    ? type === 'PERCENTAGE'
      ? numValue
      : Math.min(100, (numValue / lineSubtotal) * 100)
    : 0;
  const overLimit = isNum && !withinDiscountLimit(roleLimit, percentEquivalent);
  const invalidType =
    type === 'PERCENTAGE' && numValue > 100
      ? 'Percentage discount cannot exceed 100%.'
      : type === 'FIXED' && numValue > lineSubtotal
        ? 'Fixed discount cannot exceed the line subtotal.'
        : null;

  const discountAmount = isNum
    ? type === 'PERCENTAGE'
      ? round2(lineSubtotal * (numValue / 100))
      : Math.min(lineSubtotal, round2(numValue))
    : 0;
  const newLineTotal = Math.max(0, lineSubtotal - discountAmount);

  const canApply = isNum && !invalidType && !overLimit;

  const apply = () => {
    if (!canApply) return;
    onApply({
      type,
      value: numValue,
      reason: [reason, note].filter(Boolean).join(' — ') || undefined,
    });
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Discount — ${line.name}`}
      description={`Current item total: ${formatMoney(lineSubtotal)}`}
      footer={
        <>
          {line.discount ? (
            <Button variant="ghost" onClick={() => onApply(null)}>
              Remove discount
            </Button>
          ) : null}
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={apply} disabled={!canApply}>
            {line.discount ? 'Update discount' : 'Apply discount'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => setType('PERCENTAGE')}
            className={`rounded-md border px-3 py-2 text-sm font-medium transition-colors ${
              type === 'PERCENTAGE'
                ? 'border-primary bg-brand-100 text-primary'
                : 'border-border bg-surface text-muted-foreground hover:border-primary'
            }`}
          >
            Percentage
          </button>
          <button
            type="button"
            onClick={() => setType('FIXED')}
            className={`rounded-md border px-3 py-2 text-sm font-medium transition-colors ${
              type === 'FIXED'
                ? 'border-primary bg-brand-100 text-primary'
                : 'border-border bg-surface text-muted-foreground hover:border-primary'
            }`}
          >
            Fixed amount
          </button>
        </div>

        <div className="space-y-1.5">
          <label className="text-sm font-medium" htmlFor="discount-value">
            {type === 'PERCENTAGE' ? 'Percentage' : 'Amount (LKR)'}
          </label>
          <div className="relative">
            <Input
              id="discount-value"
              type="number"
              inputMode="decimal"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={type === 'PERCENTAGE' ? '10' : '200'}
              min={0}
              step={type === 'PERCENTAGE' ? '0.1' : '1'}
              autoFocus
            />
            {type === 'PERCENTAGE' ? (
              <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                %
              </span>
            ) : null}
          </div>
        </div>

        <div className="space-y-1.5">
          <label className="text-sm font-medium" htmlFor="discount-reason">
            Reason
          </label>
          <select
            id="discount-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="h-10 w-full rounded-md border border-border bg-surface px-3 text-sm"
          >
            {REASONS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1.5">
          <label className="text-sm font-medium" htmlFor="discount-note">
            Note (optional)
          </label>
          <Input
            id="discount-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Any extra context"
          />
        </div>

        <div className="rounded-md border border-border bg-muted/40 p-3 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Original</span>
            <span className="tabular-nums">{formatMoney(lineSubtotal)}</span>
          </div>
          <div className="flex items-center justify-between text-success">
            <span>Discount</span>
            <span className="tabular-nums">- {formatMoney(discountAmount)}</span>
          </div>
          <div className="mt-1 flex items-center justify-between border-t border-dashed border-border pt-1 text-base font-semibold">
            <span>New item total</span>
            <span className="tabular-nums text-primary">{formatMoney(newLineTotal)}</span>
          </div>
        </div>

        {invalidType ? (
          <p className="flex items-center gap-1 text-sm text-danger">
            <AlertTriangle className="h-4 w-4" />
            {invalidType}
          </p>
        ) : overLimit ? (
          <p className="flex items-start gap-2 rounded-md bg-warning/10 p-2 text-sm text-warning">
            <ShieldCheck className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <span>
              This discount exceeds your role limit ({roleLimit}%). Manager approval is
              required — approval flow lands in a follow-up slice. Apply is disabled until
              a manager approves.
            </span>
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
