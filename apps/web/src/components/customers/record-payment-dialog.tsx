'use client';

import * as React from 'react';

import { PAYMENT_METHOD_LABELS } from '@hardware-pos/shared';

import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import type { Session } from '@/lib/auth';
import { recordAccountPayment } from '@/lib/customers-api';
import type { PaymentMethodCode } from '@/lib/sales';
import { formatMoney } from '@/lib/utils';

const METHODS = Object.keys(PAYMENT_METHOD_LABELS) as PaymentMethodCode[];

/**
 * Capture a payment received against a customer's credit account.
 *
 * Opens with the full account balance already filled in, since settling up is
 * the common case, but the amount stays editable so a customer paying part of
 * what they owe is a single edit rather than a workaround.
 *
 * The money is not applied to any one invoice: while anything is still owed
 * every credit sale stays outstanding, and the moment the account reaches zero
 * they are all covered together.
 */
export function RecordPaymentDialog({
  session,
  customerId,
  customerName,
  outstanding,
  open,
  onClose,
  onRecorded,
}: {
  session: Session;
  customerId: string;
  customerName: string;
  outstanding: number;
  open: boolean;
  onClose: () => void;
  onRecorded: (result: { outstanding: number; salesSettled: number }) => void;
}) {
  const [amount, setAmount] = React.useState('');
  const [method, setMethod] = React.useState<PaymentMethodCode>('CASH');
  const [reference, setReference] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Reset on each open: a stale amount from a previous sale is the one mistake
  // this dialog must never make.
  React.useEffect(() => {
    if (!open) return;
    setAmount(outstanding > 0 ? outstanding.toFixed(2) : '');
    setMethod('CASH');
    setReference('');
    setError(null);
  }, [open, outstanding]);

  const parsed = Number(amount);
  const valid = amount.trim() !== '' && Number.isFinite(parsed) && parsed > 0 && parsed <= outstanding;

  const submit = async () => {
    if (!valid || saving) return;
    setSaving(true);
    setError(null);
    try {
      const result = await recordAccountPayment(session, {
        customerId,
        method,
        amount: parsed,
        reference: reference.trim() || undefined,
      });
      onRecorded(result);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not record the payment');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Record payment"
      description={`${customerName} · ${formatMoney(outstanding)} outstanding on account`}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={!valid || saving}>
            {saving ? 'Recording…' : 'Record payment'}
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="space-y-1.5">
          <Label htmlFor="payment-amount">Amount received</Label>
          <Input
            id="payment-amount"
            type="number"
            inputMode="decimal"
            step="0.01"
            min="0.01"
            max={outstanding}
            value={amount}
            autoFocus
            onChange={(e) => setAmount(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            Up to {formatMoney(outstanding)}. Anything less leaves the account — and every
            invoice on it — still on credit.
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="payment-method">Payment method</Label>
          <Select
            id="payment-method"
            value={method}
            onChange={(e) => setMethod(e.target.value as PaymentMethodCode)}
          >
            {METHODS.map((m) => (
              <option key={m} value={m}>
                {PAYMENT_METHOD_LABELS[m]}
              </option>
            ))}
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="payment-reference">Reference (optional)</Label>
          <Input
            id="payment-reference"
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            placeholder="Cheque number, transfer ID, receipt no…"
          />
        </div>

        {error ? <p className="text-sm text-danger">{error}</p> : null}
        {/* Submit on Enter without a second visible button. */}
        <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
      </form>
    </Dialog>
  );
}
