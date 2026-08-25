'use client';

import { AlertTriangle, CircleDollarSign, CreditCard, QrCode, Truck } from 'lucide-react';
import * as React from 'react';

import { ApiError } from '@/lib/api';
import { type Session } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Sheet } from '@/components/ui/sheet';
import { billing, takeaway } from '@/lib/restaurant/api';
import { formatMoney } from '@/lib/restaurant/labels';
import type { PaymentMethod } from '@/lib/restaurant/types';
import {
  useIsTabletUp,
  useOrientation,
  usePointerCoarse,
} from '@/lib/use-viewport';

import { NumericKeypad } from '../payment/numeric-keypad';
import type { DraftLine } from '../pos-types';
import type { PosMode } from '../pos-mode-selector';
import type { ChosenCustomer } from './customer-capture-popup';
import { printSaleReceipt } from '@/lib/restaurant/bill-print';

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

  // Viewport-aware affordances: portrait tablet gets a full-height sheet so
  // the keypad has room; landscape stays at auto so the sheet only claims the
  // height it needs. Coarse-pointer tablets get the on-screen numeric keypad
  // alongside the input — cashiers on a bench-mounted iPad hit 56px keys far
  // faster than the OS keyboard, and the keyboard occluding the CTA is the
  // number-one complaint from the pilot.
  const isTabletUp = useIsTabletUp();
  const isCoarse = usePointerCoarse();
  const orientation = useOrientation();
  const showKeypad = isTabletUp && isCoarse;
  const sheetHeight: 'auto' | 'full' = orientation === 'portrait' ? 'full' : 'auto';

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
        items: draft.map((r) =>
          // D46 — route the discriminated union at the boundary. Legacy
          // MENU_ITEM lines keep the historic wire shape byte-for-byte;
          // PRODUCT lines emit `{sourceKind, productId, productVariantId?}`.
          // The server resolves the variant + snapshots price/name.
          r.sourceKind === 'PRODUCT'
            ? {
                sourceKind: 'PRODUCT' as const,
                productId: r.productId!,
                productVariantId: r.productVariantId,
                quantity: r.quantity,
                specialInstructions: r.specialInstructions.trim() || undefined,
                modifiers: r.modifiers.map((m) => ({ modifierOptionId: m.optionId })),
              }
            : {
                menuItemId: r.menuItemId,
                quantity: r.quantity,
                specialInstructions: r.specialInstructions.trim() || undefined,
                modifiers: r.modifiers.map((m) => ({ modifierOptionId: m.optionId })),
              },
        ),
      });

      let saleId: string | null = null;
      let paidNow = false;
      let receiptPrinted = false;

      if (!isDelivery) {
        // Step 2: hand over → creates a Sale (UNPAID). The updated
        // TakeawayView now carries `finalSaleId` directly (Pilot Change 3
        // additive backend), so we can go straight to payment.
        const handedOver = await takeaway.updateStatus(session, takeawayRow.id, {
          status: 'HANDED_OVER',
        });
        saleId = handedOver.finalSaleId;

        if (saleId) {
          // Step 3: collect payment. The billing endpoint reconciles
          // against Sale.total server-side; if the operator's cart
          // amount disagreed with the server total, the server refuses
          // and the operator sees the difference in the popup.
          try {
            const bill = await billing.get(session, saleId).catch(() => null);
            const authoritativeTotal = bill ? Number(bill.total) : total;
            await billing.collectPayment(session, saleId, {
              amount: authoritativeTotal,
              method,
              reference: reference.trim() || undefined,
            });
            paidNow = true;

            /*
             * D98 — the receipt prints itself.
             *
             * A counter order is handed over at the counter: the operator has
             * the customer in front of them and nothing to click. It prints
             * from the SALE rather than from the cart, because the server is
             * what decided the totals — service charge, tax and rounding are
             * applied when the sale is created, and paper that disagrees with
             * the money taken is worse than no paper.
             *
             * Failure here must not fail the order. The food is already on its
             * way to the kitchen and the money is already collected; a printer
             * that is out of paper is a reprint, not a rollback. The
             * completion screen reports it, and Orders can reprint.
             */
            try {
              await printSaleReceipt(session, saleId, { cashierName: session.user.name });
              receiptPrinted = true;
            } catch {
              receiptPrinted = false;
            }
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
        receiptPrinted,
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
    // Swap `<Dialog>` for `<Sheet>` — same role="dialog" aria-modal semantics
    // for existing selectors, but the sheet fills the tablet correctly and
    // pins the primary action via the `footer` prop instead of relying on
    // page flow. Height flips to `full` in portrait so the on-screen keypad
    // has room without pushing the CTA below the fold.
    <Sheet
      open
      onClose={onBack}
      height={sheetHeight}
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
          {/* Method tiles: 2-across on portrait/phones so each stays big
              enough to hit confidently; 4-across at `tab:` because a landscape
              tablet already has room for a single row. `min-h-[6rem]` keeps
              each tile at a comfortable 96px touch target. */}
          <div className="grid grid-cols-2 gap-3 tab:grid-cols-4">
            {methodOptions.map((m) => (
              <button
                key={m.method}
                type="button"
                onClick={() => setMethod(m.method)}
                aria-pressed={method === m.method}
                className={`flex min-h-[6rem] flex-col items-center justify-center gap-1 rounded-lg border-2 p-3 text-sm font-medium transition-colors touch-manipulation active:scale-[0.98] ${
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
            <div className="flex flex-wrap gap-2">
              {quickCashAmounts(total).map((amount) => (
                <button
                  key={amount}
                  type="button"
                  onClick={() => setTendered(String(amount))}
                  className="min-h-11 flex-1 rounded-lg border border-border bg-surface px-3 py-2 text-sm font-medium hover:border-primary touch-manipulation"
                >
                  {amount === Math.round(total) ? 'Exact' : formatMoney(amount)}
                </button>
              ))}
            </div>
            {showKeypad ? (
              // On-screen keypad appears below the input on coarse-pointer
              // tablets. Desktop mouse users fall back to the plain input +
              // OS keyboard — the keypad's 56px keys are a touch affordance,
              // not a functional replacement.
              <div className="pt-2">
                <NumericKeypad
                  onPress={(key) => setTendered((prev) => applyKeypad(prev, key))}
                  onEnter={submit}
                  enterDisabled={submitting || tendered === '' || tenderedInvalid}
                />
              </div>
            ) : null}
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
    </Sheet>
  );
}

/**
 * Apply one keypad press to the currently-entered tendered string. The keypad
 * emits digits '0'-'9', '00', '.', and 'back'; every other value is ignored
 * so a future keypad extension can add symbols without silently corrupting
 * the numeric state here.
 */
function applyKeypad(prev: string, key: string): string {
  if (key === 'back') return prev.slice(0, -1);
  if (key === '.') {
    if (prev.includes('.')) return prev;
    return prev === '' ? '0.' : `${prev}.`;
  }
  if (key === '00') {
    // Reject a leading '00' — mirrors what a decimal input would render.
    if (prev === '' || prev === '0') return '0';
    return `${prev}00`;
  }
  if (/^\d$/.test(key)) {
    // Collapse a single leading zero (`0` + `5` → `5`) so amounts don't
    // pick up a leading zero after the operator taps 0 first.
    if (prev === '0') return key;
    return `${prev}${key}`;
  }
  return prev;
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
