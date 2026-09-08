'use client';

import {
  Banknote,
  Clock,
  Coins,
  CreditCard,
  Landmark,
  QrCode,
  ScrollText,
  type LucideIcon,
} from 'lucide-react';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import type { CartTotals } from '@/lib/cart';
import type { PaymentMethodCode } from '@/lib/sales';
import { cn, formatMoney, round2 } from '@/lib/utils';

type PayMode = 'FULL' | 'PARTIAL' | 'CREDIT';

interface MethodOption {
  key: string;
  label: string;
  Icon: LucideIcon;
  mode: PayMode;
  method?: PaymentMethodCode;
  reference?: boolean;
}

const OPTIONS: MethodOption[] = [
  { key: 'CASH', label: 'Cash', Icon: Banknote, mode: 'FULL', method: 'CASH' },
  { key: 'CARD', label: 'Card', Icon: CreditCard, mode: 'FULL', method: 'CARD', reference: true },
  { key: 'BANK_TRANSFER', label: 'Bank Transfer', Icon: Landmark, mode: 'FULL', method: 'BANK_TRANSFER', reference: true },
  { key: 'QR_PAYMENT', label: 'QR Payment', Icon: QrCode, mode: 'FULL', method: 'QR_PAYMENT', reference: true },
  { key: 'CHECK', label: 'Cheque', Icon: ScrollText, mode: 'FULL', method: 'CHECK', reference: true },
  { key: 'CREDIT', label: 'Credit / Pay Later', Icon: Clock, mode: 'CREDIT' },
  { key: 'PARTIAL', label: 'Partial Payment', Icon: Coins, mode: 'PARTIAL' },
];

const PARTIAL_METHODS: { value: PaymentMethodCode; label: string }[] = [
  { value: 'CASH', label: 'Cash' },
  { value: 'CARD', label: 'Card' },
  { value: 'BANK_TRANSFER', label: 'Bank Transfer' },
  { value: 'QR_PAYMENT', label: 'QR Payment' },
  { value: 'CHECK', label: 'Cheque' },
];

export interface PaymentSubmission {
  mode: PayMode;
  method: PaymentMethodCode | null;
  amount: number;
  reference?: string;
}

export function PaymentDialog({
  open,
  totals,
  currency,
  hasCustomer,
  submitting,
  error,
  onClose,
  onSubmit,
}: {
  open: boolean;
  totals: CartTotals;
  currency: string;
  hasCustomer: boolean;
  submitting: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (submission: PaymentSubmission) => void;
}) {
  const [methodKey, setMethodKey] = React.useState('CASH');
  const [tendered, setTendered] = React.useState('');
  const [partialAmount, setPartialAmount] = React.useState('');
  const [subMethod, setSubMethod] = React.useState<PaymentMethodCode>('CASH');
  const [reference, setReference] = React.useState('');

  React.useEffect(() => {
    if (open) {
      setMethodKey('CASH');
      setTendered(totals.total.toFixed(2));
      setPartialAmount('');
      setSubMethod('CASH');
      setReference('');
    }
  }, [open, totals.total]);

  const option = OPTIONS.find((o) => o.key === methodKey) ?? OPTIONS[0]!;
  const total = totals.total;

  const paidAmount =
    option.mode === 'CREDIT'
      ? 0
      : option.mode === 'PARTIAL'
        ? round2(Number(partialAmount) || 0)
        : total;
  const balance = Math.max(0, round2(total - paidAmount));
  const change = option.key === 'CASH' ? round2(Math.max(0, (Number(tendered) || 0) - total)) : 0;

  const needsCustomer = option.mode !== 'FULL';
  const invalid =
    submitting ||
    (needsCustomer && !hasCustomer) ||
    (option.mode === 'PARTIAL' && (paidAmount <= 0 || paidAmount >= total)) ||
    (option.key === 'CASH' && (Number(tendered) || 0) < total);

  const submit = () => {
    const method =
      option.mode === 'CREDIT' ? null : option.mode === 'PARTIAL' ? subMethod : option.method!;
    onSubmit({ mode: option.mode, method, amount: paidAmount, reference: reference.trim() || undefined });
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Payment"
      description={`Total due ${formatMoney(total, currency)}`}
      className="max-w-lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button size="lg" onClick={submit} disabled={invalid}>
            {submitting ? 'Saving…' : 'Complete sale'}
          </Button>
        </>
      }
    >
      <div className="max-h-[60vh] space-y-5 overflow-auto">
        {/* Methods */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {OPTIONS.map((o) => (
            <button
              key={o.key}
              onClick={() => setMethodKey(o.key)}
              className={cn(
                'flex flex-col items-center gap-1.5 rounded-xl border p-3 text-center text-xs font-medium transition-colors',
                methodKey === o.key
                  ? 'border-primary bg-brand-50 text-brand-700'
                  : 'border-border text-muted-foreground hover:bg-muted',
              )}
            >
              <o.Icon className="h-5 w-5" />
              {o.label}
            </button>
          ))}
        </div>

        {/* Dynamic fields */}
        {option.key === 'CASH' ? (
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="tendered">Amount tendered</Label>
              <Input id="tendered" inputMode="decimal" value={tendered} onChange={(e) => setTendered(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Change</Label>
              <div className="flex h-11 items-center rounded-xl bg-muted px-4 text-sm font-semibold">
                {formatMoney(change, currency)}
              </div>
            </div>
          </div>
        ) : null}

        {option.mode === 'PARTIAL' ? (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="partial">Amount paid now</Label>
                <Input id="partial" inputMode="decimal" placeholder="0.00" value={partialAmount} onChange={(e) => setPartialAmount(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="submethod">Paid by</Label>
                <Select id="submethod" value={subMethod} onChange={(e) => setSubMethod(e.target.value as PaymentMethodCode)}>
                  {PARTIAL_METHODS.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </Select>
              </div>
            </div>
          </div>
        ) : null}

        {option.reference || option.mode === 'PARTIAL' ? (
          <div className="space-y-1.5">
            <Label htmlFor="reference">
              {option.key === 'CHECK' ? 'Cheque number' : 'Reference'} (optional)
            </Label>
            <Input id="reference" value={reference} onChange={(e) => setReference(e.target.value)} placeholder="e.g. txn / auth ref" />
          </div>
        ) : null}

        {/* Summary */}
        <div className="space-y-1.5 rounded-xl border border-border p-4 text-sm">
          <Line label="Subtotal" value={formatMoney(totals.subtotal, currency)} />
          {totals.totalDiscount > 0 ? (
            <Line label="Product discount" value={`-${formatMoney(totals.totalDiscount, currency)}`} />
          ) : null}
          {totals.promotionOrderDiscountAmount > 0 ? (
            <Line
              label={totals.promotionOrderName ?? 'Promotion'}
              value={`-${formatMoney(totals.promotionOrderDiscountAmount, currency)}`}
            />
          ) : null}
          {totals.orderDiscountAmount > 0 ? (
            <Line label="Order discount" value={`-${formatMoney(totals.orderDiscountAmount, currency)}`} />
          ) : null}
          <Line label="Tax / VAT" value={formatMoney(totals.taxAmount, currency)} />
          <Line label="Total amount" value={formatMoney(total, currency)} />
          <Line label="Paid amount" value={formatMoney(paidAmount, currency)} />
          <Line label="Balance" value={formatMoney(balance, currency)} strong={balance > 0} />
          <Line label="Method" value={option.label} />
        </div>

        {needsCustomer && !hasCustomer ? (
          <p className="text-sm text-warning">Select a customer for a credit or partial sale.</p>
        ) : null}
        {error ? <p className="text-sm text-danger">{error}</p> : null}
      </div>
    </Dialog>
  );
}

function Line({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className={cn(strong ? 'font-semibold text-danger' : 'font-medium text-foreground')}>{value}</span>
    </div>
  );
}
