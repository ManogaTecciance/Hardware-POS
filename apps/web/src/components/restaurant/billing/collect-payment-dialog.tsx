'use client';

import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { type Session } from '@/lib/auth';
import { billing } from '@/lib/restaurant/api';
import { formatMoney } from '@/lib/restaurant/labels';
import type { BillView, PaymentMethod } from '@/lib/restaurant/types';

export const PAYMENT_METHODS: { value: PaymentMethod; label: string }[] = [
  { value: 'CASH', label: 'Cash' },
  { value: 'CARD', label: 'Card' },
  { value: 'BANK_TRANSFER', label: 'Bank transfer' },
  { value: 'QR_PAYMENT', label: 'QR payment' },
  { value: 'CHECK', label: 'Check' },
  { value: 'STORE_CREDIT', label: 'Store credit' },
  { value: 'OTHER', label: 'Other' },
];

/**
 * The till's tender dialog. Lived inside the bill screen until D153 put a
 * "Collect payment" button on the Orders queue too; moved here verbatim so
 * both surfaces record money through the one form.
 */
export function CollectPaymentDialog({
  bill,
  suggested,
  splitId,
  onClose,
  onCollected,
  session,
}: {
  bill: BillView;
  suggested: string;
  /** D51 — when set, the tender is allocated to this split, not the whole bill. */
  splitId: string | null;
  onClose: () => void;
  onCollected: () => Promise<void>;
  session: Session;
}) {
  const [amount, setAmount] = React.useState(suggested);
  const [method, setMethod] = React.useState<PaymentMethod>('CASH');
  const [reference, setReference] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const numAmount = Number(amount);
  const valid = numAmount > 0;

  const submit = async () => {
    if (!valid) return;
    setSaving(true);
    setError(null);
    try {
      await billing.collectPayment(session, bill.saleId, {
        amount: numAmount,
        method,
        reference: reference.trim() || undefined,
        splitId: splitId ?? undefined,
      });
      await onCollected();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to record payment');
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="Collect payment"
      description={`Bill balance: ${formatMoney(bill.balanceAmount)}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={submit} isLoading={saving} disabled={!valid}>
            Record payment
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="space-y-1.5">
          <label className="text-sm font-medium" htmlFor="pay-amount">
            Amount
          </label>
          <Input
            id="pay-amount"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            inputMode="decimal"
            autoFocus
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-sm font-medium" htmlFor="pay-method">
            Method
          </label>
          <select
            id="pay-method"
            value={method}
            onChange={(e) => setMethod(e.target.value as PaymentMethod)}
            className="h-11 w-full rounded-lg border border-border bg-surface px-3 text-sm"
          >
            {PAYMENT_METHODS.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <label className="text-sm font-medium" htmlFor="pay-reference">
            Reference (optional)
          </label>
          <Input
            id="pay-reference"
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            placeholder="Auth code, cheque #, etc."
          />
        </div>
        {error ? <p className="text-sm text-danger">{error}</p> : null}
      </div>
    </Dialog>
  );
}
