'use client';

import { ExternalLink, Loader2, Printer } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { useAuth, type Session } from '@/lib/auth';
import { getDocumentProfile } from '@/lib/document-template-service';
import { Permission } from '@/lib/permissions';
import { printReceipt } from '@/lib/receipt-print';
import { billing } from '@/lib/restaurant/api';
import { formatMoney } from '@/lib/restaurant/labels';
import { getActiveCurrency } from '@/lib/tenant-money';
import { renderThermalBill } from '@/lib/thermal-bill';
import type { BillView } from '@/lib/restaurant/types';

interface Props {
  session: Session;
  saleId: string;
  /** Heading line — the table, or the order number. */
  title?: string;
  onClose: () => void;
}

/**
 * D83 — the finalised bill, in place.
 *
 * A waiter who has just closed a table, and anyone opening a settled row on
 * the Orders page, wants the same two things: to read the bill and to put it
 * on paper. Both used to get a LINK to `/bills/:id` — which takes a waiter
 * off the POS screen mid-service, and which the Orders page did not even
 * offer (the button was there, disabled, marked for a follow-up slice).
 *
 * Reprinting is the point of this dialog, so it is not gated behind the
 * billing screen's permissions: a waiter holds BILL_VIEW and can reprint what
 * they just closed. Settling is still the till's — nothing here collects
 * money.
 */
export function BillDialog({ session, saleId, title, onClose }: Props) {
  const router = useRouter();
  const { hasPermission } = useAuth();
  const [bill, setBill] = React.useState<BillView | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [printing, setPrinting] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    billing
      .get(session, saleId)
      .then((b) => {
        if (!cancelled) setBill(b);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Could not load the bill');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [session, saleId]);

  const print = async (view: BillView) => {
    setPrinting(true);
    try {
      const profile = await getDocumentProfile(session);
      printReceipt(
        renderThermalBill({
          profile,
          fallbackName: session.branchName ?? '',
          currency: getActiveCurrency(),
          documentNumber: view.saleNumber,
          placeLabel: view.placeLabel,
          servedBy: view.servedByName,
          issuedAt: new Date(view.closedAt),
          lines: view.items.map((it) => ({
            name: it.name,
            variantName: it.variantName,
            quantity: it.quantity,
            lineTotal: it.lineTotal,
            specialInstructions: it.specialInstructions,
          })),
          subtotal: view.subtotal,
          discount: view.totalDiscount,
          serviceCharge: view.serviceChargeAmount,
          packaging: view.packagingCharge,
          tax: view.taxAmount,
          total: view.total,
          paid: view.paidAmount,
          balance: view.balanceAmount,
          payments: view.payments.map((p) => ({ method: p.method, amount: p.amount })),
          note: profile.billNote || null,
        }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not prepare the bill');
    } finally {
      setPrinting(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={title ?? bill?.saleNumber ?? 'Bill'}
      description={
        bill
          ? `${bill.saleNumber}${bill.placeLabel ? ` · ${bill.placeLabel}` : ''}`
          : 'Loading the bill…'
      }
      className="sm:max-w-lg"
      footer={
        <>
          {/* The billing screen is where money is collected; this dialog is
              read-and-reprint. Offered only to a role that can settle. */}
          {hasPermission(Permission.PAYMENT_COLLECT) ? (
            <Button
              variant="ghost"
              leftIcon={<ExternalLink className="h-4 w-4" />}
              onClick={() => router.push(`/bills/${saleId}`)}
            >
              Open billing
            </Button>
          ) : null}
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button
            leftIcon={<Printer className="h-4 w-4" />}
            isLoading={printing}
            disabled={!bill}
            onClick={() => bill && void print(bill)}
          >
            Print bill
          </Button>
        </>
      }
    >
      {error ? <p className="text-sm text-danger">{error}</p> : null}

      {!bill && !error ? (
        <p className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading…
        </p>
      ) : null}

      {bill ? (
        <div className="space-y-4">
          <ul className="space-y-1.5">
            {bill.items.map((it) => (
              <li key={it.orderItemId} className="flex items-start justify-between gap-3 text-sm">
                <span className="min-w-0">
                  <span className="font-medium">{trimQuantity(it.quantity)}× </span>
                  {it.name}
                  {it.variantName ? (
                    <span className="ml-1 text-xs text-muted-foreground">{it.variantName}</span>
                  ) : null}
                  {it.specialInstructions ? (
                    <span className="block text-xs italic text-warning">
                      {it.specialInstructions}
                    </span>
                  ) : null}
                </span>
                <span className="shrink-0 tabular-nums">{formatMoney(it.lineTotal)}</span>
              </li>
            ))}
          </ul>

          <div className="space-y-1 border-t border-border pt-3 text-sm">
            <Row label="Subtotal" value={bill.subtotal} />
            {Number(bill.totalDiscount) > 0 ? (
              <Row label="Discount" value={`-${bill.totalDiscount}`} />
            ) : null}
            {Number(bill.serviceChargeAmount) > 0 ? (
              <Row label="Service charge" value={bill.serviceChargeAmount} />
            ) : null}
            {Number(bill.packagingCharge) > 0 ? (
              <Row label="Packaging" value={bill.packagingCharge} />
            ) : null}
            {Number(bill.taxAmount) > 0 ? <Row label="Tax" value={bill.taxAmount} /> : null}
            <div className="flex items-center justify-between border-t border-border pt-2 text-base font-semibold">
              <span>Total</span>
              <span className="tabular-nums">{formatMoney(bill.total)}</span>
            </div>
            <Row label="Paid" value={bill.paidAmount} />
            {Number(bill.balanceAmount) > 0 ? (
              <div className="flex items-center justify-between font-medium text-warning">
                <span>Balance due</span>
                <span className="tabular-nums">{formatMoney(bill.balanceAmount)}</span>
              </div>
            ) : null}
          </div>

          {/* D71 — a table split at the table arrives here as several shares;
              the cashier settles each one separately. */}
          {bill.splits.length > 0 ? (
            <div className="space-y-1 border-t border-border pt-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Split into {bill.splits.length}
              </p>
              {bill.splits.map((sp, i) => (
                <div key={sp.id} className="flex items-center justify-between text-sm">
                  <span>{sp.label ?? `Guest ${i + 1}`}</span>
                  <span className="tabular-nums">
                    {formatMoney(sp.share)}
                    {Number(sp.paidAmount) > 0 ? (
                      <span className="ml-2 text-xs text-success">
                        paid {formatMoney(sp.paidAmount)}
                      </span>
                    ) : null}
                  </span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </Dialog>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between text-muted-foreground">
      <span>{label}</span>
      <span className="tabular-nums">{formatMoney(value)}</span>
    </div>
  );
}

function trimQuantity(q: string): string {
  return String(Number(q));
}
