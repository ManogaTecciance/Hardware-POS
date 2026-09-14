'use client';

import { orderCallTag } from '@hardware-pos/shared';
import { CheckCircle2, ChefHat, Receipt, ShoppingCart } from 'lucide-react';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { formatMoney } from '@/lib/restaurant/labels';
import type { PaymentMethod } from '@/lib/restaurant/types';

import type { PosMode } from '../pos-mode-selector';

export interface CompletionSummary {
  orderNumber: string;
  /** D197 — the call-out number the cashier tells the customer; null before D197. */
  callNumber: number | null;
  mode: PosMode;
  paidNow: boolean;
  change: number | null;
  method: PaymentMethod | null;
  saleId: string | null;
  takeawayId: string;
  /**
   * D98 — whether the receipt actually reached the printer.
   *
   * Reported rather than assumed. The order completes either way (the food is
   * cooking and the money is taken), so a printer that is out of paper must
   * say so here instead of leaving the operator to notice nothing came out.
   */
  receiptPrinted: boolean;
}

interface Props {
  summary: CompletionSummary;
  onNewOrder: () => void;
  onViewOrder: () => void;
}

/**
 * The short confirmation the cashier sees after a successful placement.
 *
 * Deliberately not celebratory — a checkmark, three status lines, and the
 * two next-steps. Cashiers close 300 orders a shift; this screen must
 * average under 2 seconds of gaze time.
 */
export function OrderCompletionScreen({ summary, onNewOrder, onViewOrder }: Props) {
  const isDelivery = summary.mode === 'THIRD_PARTY';
  return (
    <Dialog
      open
      onClose={onNewOrder}
      title={`Order ${orderCallTag(summary)} created`}
      description={
        isDelivery
          ? 'Delivery order confirmed. Rider marks Handed Over when the customer receives it.'
          : summary.paidNow
            ? 'Payment collected and kitchen has been notified.'
            : 'Order created — payment pending. Collect from Bills.'
      }
      footer={
        <>
          <Button variant="outline" onClick={onViewOrder}>
            View in Orders
          </Button>
          <Button onClick={onNewOrder} leftIcon={<ShoppingCart className="h-4 w-4" />}>
            New Order
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {/* D197 — the one thing this screen exists to hand over: the number
            the customer listens for. Big, first, and gone on a delivery order,
            where the rider collects by the partner's reference instead. */}
        {!isDelivery && summary.callNumber !== null ? (
          <div className="rounded-md border border-border bg-muted/40 p-3 text-center" data-testid="call-number">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Tell the customer
            </p>
            <p className="text-4xl font-bold tabular-nums">#{summary.callNumber}</p>
            <p className="text-xs text-muted-foreground" data-testid="order-reference">
              {summary.orderNumber}
            </p>
          </div>
        ) : (
          // The permanent reference still has to be on the screen: it is what
          // the queue, the audit log and the e2e proof look the order up by.
          <p className="text-xs text-muted-foreground" data-testid="order-reference">
            {summary.orderNumber}
          </p>
        )}
        <StatusRow
          icon={<Receipt className="h-4 w-4" />}
          label={
            isDelivery
              ? 'Sale created (unpaid — COD)'
              : summary.paidNow
                ? 'Payment completed'
                : 'Sale created (unpaid)'
          }
          on={summary.paidNow || !isDelivery}
        />
        <StatusRow
          icon={<ChefHat className="h-4 w-4" />}
          label="KOT sent to Kitchen"
          on={true}
        />
        <StatusRow
          icon={<Receipt className="h-4 w-4" />}
          label={
            isDelivery
              ? 'Receipt ready'
              : summary.receiptPrinted
                ? 'Receipt printed'
                : summary.paidNow
                  ? 'Receipt not printed — reprint from Orders'
                  : 'Receipt ready'
          }
          on={isDelivery ? summary.paidNow : summary.receiptPrinted}
          muted={isDelivery}
        />

        {summary.paidNow && summary.change !== null && summary.change > 0 ? (
          <div className="rounded-md border border-success/40 bg-success-soft p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-success">Change</p>
            <p className="mt-1 text-2xl font-bold tabular-nums text-success">
              {formatMoney(summary.change)}
            </p>
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}

function StatusRow({
  icon,
  label,
  on,
  muted,
}: {
  icon: React.ReactNode;
  label: string;
  on: boolean;
  muted?: boolean;
}) {
  return (
    <div
      className={`flex items-center gap-3 rounded-md border p-2.5 text-sm ${
        on
          ? 'border-success/40 bg-success-soft'
          : muted
            ? 'border-border bg-muted/40 text-muted-foreground'
            : 'border-warning/40 bg-warning-soft text-warning'
      }`}
    >
      <div className={on ? 'text-success' : muted ? 'text-muted-foreground' : 'text-warning'}>
        {icon}
      </div>
      <span className="flex-1 font-medium">{label}</span>
      {on ? <CheckCircle2 className="h-4 w-4 text-success" /> : null}
    </div>
  );
}
