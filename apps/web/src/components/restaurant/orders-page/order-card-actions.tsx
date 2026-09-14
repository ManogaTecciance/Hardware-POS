'use client';

import { CreditCard, HandCoins, Printer } from 'lucide-react';
import * as React from 'react';

import { CollectPaymentDialog } from '@/components/restaurant/billing/collect-payment-dialog';
import { Button } from '@/components/ui/button';
import { type Session } from '@/lib/auth';
import { Permission } from '@/lib/permissions';
import { billing, tableSessions } from '@/lib/restaurant/api';
import { printBillView } from '@/lib/restaurant/bill-print';
import { freshIdempotencyKey } from '@/lib/restaurant/idempotency';
import type { BillView, UnifiedOrderView } from '@/lib/restaurant/types';

interface Props {
  session: Session;
  order: UnifiedOrderView;
  /** Called after any write, so the queue refetches instead of waiting out the poll. */
  onMutated?: () => void;
  size?: 'sm' | 'md';
  className?: string;
}

/**
 * D178 — the dine-in settlement verbs, on the queue.
 *
 * Two roles, two moments, one component so the card footer and the detail
 * drawer cannot offer different buttons for the same row:
 *
 * - **Proceed to pay** — the waiter's, on a READY table. Raises the bill and
 *   sends it to the till; the table is held until paid. `TABLE_CLOSE`, which
 *   the Waiter template holds and the Cashier does not.
 * - **Print bill** / **Collect payment** — the till's, on a table that is at
 *   the till (`AWAITING_PAYMENT`). Both behind `PAYMENT_COLLECT` (D87: only
 *   the till prints). The payment that clears the balance also prints the
 *   paid bill, because that is the paper the guest leaves with.
 *
 * Absent rather than disabled when a verb does not apply — the house rule
 * for this drawer (see `View bill`): a greyed-out button invites people to
 * keep trying it. Dine-in only; a takeaway order settles at placement (D117)
 * and a third-party order settles on the platform.
 */
export function OrderCardActions({ session, order, onMutated, size = 'sm', className }: Props) {
  // Off the session PROP, not `useAuth()`: the queue is handed its session by
  // the page and renders outside the provider in every one of its specs. The
  // check is the same one the provider makes.
  const hasPermission = (p: Permission) => session.user.permissions.includes(p);
  const [busy, setBusy] = React.useState<'send' | 'print' | 'load' | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [collecting, setCollecting] = React.useState<BillView | null>(null);

  if (order.channel !== 'DINE_IN') return null;

  const canSend =
    order.unifiedStatus === 'READY' &&
    Boolean(order.sessionId) &&
    hasPermission(Permission.TABLE_CLOSE);
  const canSettle =
    order.unifiedStatus === 'AWAITING_PAYMENT' &&
    Boolean(order.saleId) &&
    hasPermission(Permission.PAYMENT_COLLECT);

  if (!canSend && !canSettle) return null;

  const sendToCashier = async () => {
    if (busy || !order.sessionId) return;
    setBusy('send');
    setError(null);
    try {
      await tableSessions.sendToCashier(session, order.sessionId, {
        idempotencyKey: freshIdempotencyKey(),
      });
      onMutated?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send this table to the cashier');
    } finally {
      setBusy(null);
    }
  };

  const printBill = async () => {
    if (busy || !order.saleId) return;
    setBusy('print');
    setError(null);
    try {
      const view = await billing.get(session, order.saleId);
      // D87 — the cashier line names whoever pressed Print, now.
      await printBillView(session, view, { cashierName: session.user.name });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not print the bill');
    } finally {
      setBusy(null);
    }
  };

  const openCollect = async () => {
    if (busy || !order.saleId) return;
    setBusy('load');
    setError(null);
    try {
      setCollecting(await billing.get(session, order.saleId));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the bill');
    } finally {
      setBusy(null);
    }
  };

  const collected = async () => {
    if (!order.saleId) return;
    const view = await billing.get(session, order.saleId);
    setCollecting(null);
    onMutated?.();
    /*
     * The paid bill prints itself. The guest is leaving; the cashier has the
     * cash in hand; the one thing left is the paper that says so. A partial
     * payment prints nothing — the bill is not settled and the table is
     * still held.
     */
    if (view.paymentStatus === 'PAID') {
      try {
        await printBillView(session, view, { cashierName: session.user.name });
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Paid, but the bill did not print');
      }
    }
  };

  return (
    <div className={className}>
      <div className="flex flex-wrap items-center gap-2">
        {canSend ? (
          <Button
            size={size}
            leftIcon={<HandCoins className="h-4 w-4" />}
            isLoading={busy === 'send'}
            onClick={() => void sendToCashier()}
          >
            Proceed to pay
          </Button>
        ) : null}
        {canSettle ? (
          <>
            <Button
              size={size}
              variant="outline"
              leftIcon={<Printer className="h-4 w-4" />}
              isLoading={busy === 'print'}
              disabled={busy !== null && busy !== 'print'}
              onClick={() => void printBill()}
            >
              Print bill
            </Button>
            <Button
              size={size}
              leftIcon={<CreditCard className="h-4 w-4" />}
              isLoading={busy === 'load'}
              disabled={busy !== null && busy !== 'load'}
              onClick={() => void openCollect()}
            >
              Collect payment
            </Button>
          </>
        ) : null}
      </div>
      {error ? <p className="mt-1 text-xs text-danger">{error}</p> : null}
      {collecting ? (
        <CollectPaymentDialog
          session={session}
          bill={collecting}
          suggested={collecting.balanceAmount}
          splitId={null}
          onClose={() => setCollecting(null)}
          onCollected={collected}
        />
      ) : null}
    </div>
  );
}
