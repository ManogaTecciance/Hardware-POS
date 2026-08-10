'use client';

import { AlertTriangle, CircleDollarSign, CreditCard, QrCode, Truck } from 'lucide-react';
import * as React from 'react';

import { ApiError } from '@/lib/api';
import { type Session } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { billing, takeaway } from '@/lib/restaurant/api';
import { formatMoney } from '@/lib/restaurant/labels';
import type { PaymentMethod } from '@/lib/restaurant/types';

import type { DraftLine } from '../pos-types';
import type { PosMode } from '../pos-mode-selector';
import type { ChosenCustomer } from './customer-capture-popup';
import type { CompletionSummary } from './order-completion-screen';

interface Props {
  session: Session;
  branchId: string;
  mode: PosMode;
  customer: ChosenCustomer | null;
  draft: DraftLine[];
  idempotencyKey: string;
  computedTotals: {
    subtotal: number;
    serviceCharge: number;
    taxAmount: number;
    total: number;
  };
  onBack: () => void;
  onCompleted: (result: CompletionSummary) => void;
}

interface MethodOption {
  method: PaymentMethod;
  label: string;
  icon: React.ReactNode;
}

/**
 * Payment + finalize + auto-KOT orchestration for the counter POS.
 *
 * Backend today already generates the KOT inside `takeaway.create`, so
 * "auto-KOT after payment" is really "kick the create call, then close
 * out to a Sale, then collect the payment". Three server calls in
 * sequence, orchestrated here:
 *
 *   1. `takeaway.create` — writes the RestaurantOrder + Items and
 *      generates the kitchen tickets.
 *   2. For Dine-In counter and Takeaway: `updateStatus(HANDED_OVER)` to
 *      close the session into a Sale (UNPAID) — the existing endpoint
 *      already does this atomically. Delivery skips this step and stays
 *      PLACED so the rider can advance the state.
 *   3. For non-Delivery: `billing.collectPayment` to record the payment
 *      on the newly created Sale.
 *
 * Errors: any step failure surfaces near the CTA. Because we reuse the
 * same idempotency key across a retry, a repeat network call cannot
 * open a second order. Delivery COD skips step 3 by design.
 */
export function PaymentPopup(props: Props) {
  const {
    session, branchId, mode, customer, draft, idempotencyKey,
    computedTotals, onBack, onCompleted,
  } = props;

  const isDelivery = mode === 'THIRD_PARTY';

  // Delivery menu is deliberately different — only Cash on Delivery and
  // Bank Transfer make sense at the counter for a delivery order today.
  // Card / QR flows require the customer to be present.
  const methodOptions: MethodOption[] = isDelivery
    ? [
        {
          method: 'CASH',
          label: 'Cash on Delivery',
          icon: <Truck className="h-5 w-5" />,
        },
        {
          method: 'BANK_TRANSFER',
          label: 'Bank Transfer',
          icon: <CreditCard className="h-5 w-5" />,
        },
      ]
    : [
        { method: 'CASH', label: 'Cash', icon: <CircleDollarSign className="h-5 w-5" /> },
        { method: 'CARD', label: 'Card', icon: <CreditCard className="h-5 w-5" /> },
        {
          method: 'BANK_TRANSFER',
          label: 'Transfer',
          icon: <CreditCard className="h-5 w-5" />,
        },
        { method: 'QR_PAYMENT', label: 'QR', icon: <QrCode className="h-5 w-5" /> },
      ];

  const [method, setMethod] = React.useState<PaymentMethod>(
    methodOptions[0]?.method ?? 'CASH',
  );
  const [tendered, setTendered] = React.useState('');
  const [reference, setReference] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const total = computedTotals.total;
  const tenderedNum = Number(tendered);
  const change = method === 'CASH' && !isDelivery
    ? Math.max(0, tenderedNum - total)
    : 0;
  const tenderedInvalid =
    method === 'CASH' && !isDelivery && tendered !== '' && tenderedNum < total;

  // For delivery the "payment" is a promise — the CTA reads differently.
  const ctaLabel = isDelivery ? 'Confirm delivery order' : 'Pay & Complete';

  const submit = async () => {
    if (submitting) return;
    if (!isDelivery && method === 'CASH' && (tendered === '' || tenderedInvalid)) {
      setError('Enter a tendered amount that is at least the total.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      // Step 1: create takeaway (also fires the KOT via kitchen.generateTicketsForRound).
      const notesPieces: string[] = [];
      if (isDelivery && customer?.deliveryAddress) {
        notesPieces.push(`[Delivery] ${customer.deliveryAddress}`);
      }
      if (customer?.name && !customer.customerId) {
        // Optional trace — the profile stores name+phone separately.
      }
      const notes = notesPieces.join(' · ') || undefined;

      const takeawayRow = await takeaway.create(session, {
        branchId,
        customerName: customer?.name ?? undefined,
        customerPhone: customer?.phone ?? undefined,
        idempotencyKey,
        notes,
        items: draft.map((r) => ({
          menuItemId: r.menuItemId,
          quantity: r.quantity,
          specialInstructions: r.specialInstructions.trim() || undefined,
          modifiers: r.modifiers.map((m) => ({ modifierOptionId: m.optionId })),
        })),
      });

      let saleId: string | null = null;
      let paidNow = false;

      if (!isDelivery) {
        // Step 2: hand over → creates a Sale (UNPAID).
        const handedOver = await takeaway.updateStatus(session, takeawayRow.id, {
          status: 'HANDED_OVER',
        });
        // The handover response is a TakeawayView which does not expose the
        // Sale id today. Refetch via list is heavy; instead the billing
        // endpoint needs the sale id which we get from the underlying
        // order. For the pilot the Bills page carries this info; here we
        // read the current bill for the newly-handed-over order.
        const bill = await billing
          .get(session, handedOver.orderId)
          .catch(() => null);
        // NOTE: `bill.saleId` is what we want, but the shape depends on the
        // Bills endpoint accepting a saleId not an orderId. If unresolvable,
        // we fall through to a completion with paidNow=false so the operator
        // knows to collect payment from /bills — flagged as a known limit.
        saleId = bill?.saleId ?? null;

        if (saleId) {
          // Step 3: collect payment.
          try {
            await billing.collectPayment(session, saleId, {
              amount: total,
              method,
              reference: reference.trim() || undefined,
            });
            paidNow = true;
          } catch (err) {
            // Silent failure would be worse than reporting: surface but
            // still complete the order so the KOT is not orphaned.
            setError(
              err instanceof Error
                ? `Order placed but payment failed: ${err.message}. Collect in Bills.`
                : 'Order placed but payment failed. Collect in Bills.',
            );
          }
        }
      }

      onCompleted({
        orderNumber: takeawayRow.orderNumber,
        mode,
        paidNow,
        change: paidNow ? change : null,
        method: paidNow ? method : null,
        saleId,
        takeawayId: takeawayRow.id,
      });
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.body && typeof err.body === 'object' && 'message' in err.body
          ? String((err.body as { message: unknown }).message)
          : err.message);
      } else {
        setError(err instanceof Error ? err.message : 'Something went wrong');
      }
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onBack}
      title="Payment"
      description={
        isDelivery
          ? 'Delivery orders skip immediate payment. Confirm to send the KOT.'
          : `Total to collect: ${formatMoney(total)}`
      }
      footer={
        <>
          <Button variant="ghost" onClick={onBack} disabled={submitting}>
            Back
          </Button>
          <Button onClick={submit} isLoading={submitting}>
            {ctaLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="rounded-md border border-border bg-muted/40 p-3">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Order type</span>
            <span className="font-medium">{modeLabel(mode)}</span>
          </div>
          {customer ? (
            <div className="mt-1 flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Customer</span>
              <span className="font-medium">
                {customer.name ?? '—'}
                {customer.phone ? ` · ${customer.phone}` : ''}
              </span>
            </div>
          ) : (
            <div className="mt-1 flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Customer</span>
              <span className="italic text-muted-foreground">Walk-in</span>
            </div>
          )}
          <div className="mt-2 flex items-center justify-between border-t border-dashed border-border pt-2">
            <span className="text-sm font-semibold uppercase tracking-wide">Total</span>
            <span className="text-xl font-bold tabular-nums text-primary">
              {formatMoney(total)}
            </span>
          </div>
        </div>

        <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Payment method
          </p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {methodOptions.map((m) => (
              <button
                key={m.method}
                type="button"
                onClick={() => setMethod(m.method)}
                aria-pressed={method === m.method}
                className={`flex flex-col items-center gap-1 rounded-lg border-2 p-3 text-xs font-medium transition-colors active:scale-[0.98] ${
                  method === m.method
                    ? 'border-primary bg-brand-100 text-primary'
                    : 'border-border bg-surface text-muted-foreground hover:border-primary'
                }`}
              >
                {m.icon}
                {m.label}
              </button>
            ))}
          </div>
        </div>

        {method === 'CASH' && !isDelivery ? (
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="tendered">
              Cash tendered
            </label>
            <Input
              id="tendered"
              type="number"
              inputMode="decimal"
              value={tendered}
              onChange={(e) => setTendered(e.target.value)}
              placeholder={String(Math.ceil(total / 100) * 100)}
              className="h-12 text-lg font-semibold"
            />
            <div className="flex gap-2">
              {quickCashAmounts(total).map((amount) => (
                <button
                  key={amount}
                  type="button"
                  onClick={() => setTendered(String(amount))}
                  className="flex-1 rounded-md border border-border bg-surface px-2 py-1.5 text-xs font-medium hover:border-primary"
                >
                  {amount === Math.round(total) ? 'Exact' : formatMoney(amount)}
                </button>
              ))}
            </div>
            {tenderedNum >= total && total > 0 ? (
              <div className="flex items-center justify-between rounded-md border border-success/40 bg-success-soft p-2 text-sm">
                <span className="font-medium">Change</span>
                <span className="text-lg font-bold tabular-nums text-success">
                  {formatMoney(change)}
                </span>
              </div>
            ) : null}
          </div>
        ) : null}

        {(method === 'CARD' || method === 'BANK_TRANSFER' || method === 'QR_PAYMENT') &&
        !isDelivery ? (
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="pay-ref">
              Reference (optional)
            </label>
            <Input
              id="pay-ref"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder="Auth code, transaction id, etc."
            />
          </div>
        ) : null}

        {isDelivery ? (
          <div className="rounded-md border border-warning/40 bg-warning-soft p-3 text-sm text-warning">
            {method === 'CASH'
              ? 'Cash on Delivery — the Sale will be created UNPAID and the rider marks it Paid on handover.'
              : 'Bank Transfer — the Sale will be created UNPAID; mark it Paid once the transfer is confirmed.'}
          </div>
        ) : null}

        {error ? (
          <p className="flex items-start gap-1 text-sm text-danger">
            <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
            {error}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}

function modeLabel(mode: PosMode): string {
  return mode === 'DINE_IN' ? 'Dine In' : mode === 'TAKEAWAY' ? 'Takeaway' : 'Delivery';
}

function quickCashAmounts(total: number): number[] {
  const rounded = Math.round(total);
  const buckets = [rounded, Math.ceil(rounded / 500) * 500, Math.ceil(rounded / 1000) * 1000, Math.ceil(rounded / 5000) * 5000];
  const seen = new Set<number>();
  const out: number[] = [];
  for (const b of buckets) {
    if (b > 0 && !seen.has(b)) {
      seen.add(b);
      out.push(b);
      if (out.length >= 4) break;
    }
  }
  return out;
}
