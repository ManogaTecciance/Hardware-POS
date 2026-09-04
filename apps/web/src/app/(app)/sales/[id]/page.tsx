'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import * as React from 'react';
import { ArrowLeft, FileDown, HandCoins, Printer, RefreshCw, Undo2 } from 'lucide-react';

import { paymentMethodLabel } from '@hardware-pos/shared';

import { SyncBadge } from '@/components/quickbooks/sync-badge';
import { SaleReturnStatusBadge } from '@/components/returns/status-badges';
import { RecordPaymentDialog } from '@/components/sales/record-payment-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useAuth } from '@/lib/auth';
import { Permission } from '@/lib/permissions';
import { reprintCustomerReceipt } from '@/lib/receipt-print';
import { fetchSaleReturns, type ReturnDetail } from '@/lib/returns';
import { fetchSale, retrySaleSync, type PaymentStatusCode, type SaleDetail } from '@/lib/sales';
import { formatMoney } from '@/lib/utils';

const PAYMENT_STATUS: Record<
  PaymentStatusCode,
  { label: string; variant: 'success' | 'warning' | 'neutral' | 'danger' }
> = {
  PAID: { label: 'Paid', variant: 'success' },
  PARTIAL: { label: 'Partially paid', variant: 'warning' },
  UNPAID: { label: 'Credit / Unpaid', variant: 'danger' },
  REFUNDED: { label: 'Refunded', variant: 'neutral' },
};

/** A due date reads as a day; the time of day on it means nothing. */
function formatDay(iso: string): string {
  return new Date(iso).toLocaleDateString('en-LK', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
  });
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-LK', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function SaleDetailPage() {
  const { session, hasPermission } = useAuth();
  const params = useParams<{ id: string }>();
  const id = params.id;

  const [sale, setSale] = React.useState<SaleDetail | null>(null);
  const [returns, setReturns] = React.useState<ReturnDetail[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [reloadKey, setReloadKey] = React.useState(0);
  const [payOpen, setPayOpen] = React.useState(false);
  const loadedOnce = React.useRef(false);

  React.useEffect(() => {
    if (!session || !id) return;
    let cancelled = false;
    // Only the FIRST load blanks the page. Recording a payment refetches through
    // this same effect, and replacing the whole sale with "Loading sale…" for a
    // moment is a poor way to show someone the row they just added.
    if (!loadedOnce.current) setLoading(true);
    setError(null);
    fetchSale(session, id)
      .then((s) => !cancelled && setSale(s))
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load sale');
      })
      .finally(() => {
        if (cancelled) return;
        loadedOnce.current = true;
        setLoading(false);
      });
    // Prior returns for the "Returns" section (best-effort; may be empty).
    fetchSaleReturns(session, id)
      .then((r) => !cancelled && setReturns(r))
      .catch(() => !cancelled && setReturns([]));
    return () => {
      cancelled = true;
    };
  }, [session, id, reloadKey]);

  const handleReprint = async () => {
    if (!session || !sale) return;
    setBusy(true);
    try {
      await reprintCustomerReceipt(session, sale.id);
    } finally {
      setBusy(false);
    }
  };

  const handleRetry = async () => {
    if (!session || !sale) return;
    setBusy(true);
    try {
      await retrySaleSync(session, sale.id);
      setReloadKey((k) => k + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Retry failed');
    } finally {
      setBusy(false);
    }
  };

  // A4 is the default bill: open the native, print-ready A4 preview route.
  const handleA4Bill = () => {
    if (!sale) return;
    window.open(`/print/sales/${sale.id}`, '_blank', 'noopener');
  };

  if (loading) {
    return <p className="py-16 text-center text-sm text-muted-foreground">Loading sale…</p>;
  }

  if (error || !sale) {
    return (
      <div className="space-y-4">
        <Link href="/sales" className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
          <ArrowLeft className="h-4 w-4" /> Back to sales
        </Link>
        <Card>
          <CardContent className="py-16 text-center text-sm text-danger">
            {error ?? 'Sale not found'}
          </CardContent>
        </Card>
      </div>
    );
  }

  const pay = PAYMENT_STATUS[sale.paymentStatus];
  const canRetry = sale.syncStatus === 'FAILED' || sale.syncStatus === 'PENDING';
  const canReturn =
    sale.status === 'COMPLETED' &&
    sale.returnStatus !== 'FULLY_RETURNED' &&
    hasPermission(Permission.RETURN_CREATE);
  const canRecordPayment =
    sale.status === 'COMPLETED' &&
    sale.balanceAmount > 0 &&
    hasPermission(Permission.PAYMENT_CREATE);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <Link
            href="/sales"
            className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
          >
            <ArrowLeft className="h-4 w-4" /> Back to sales
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight">Sale {sale.saleNumber}</h1>
          <p className="text-sm text-muted-foreground">
            {formatDateTime(sale.completedAt ?? sale.createdAt)} ·{' '}
            {sale.customer?.name ?? 'Walk-in customer'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {canRecordPayment ? (
            <Button onClick={() => setPayOpen(true)} disabled={busy}>
              <HandCoins className="h-4 w-4" />
              Record payment
            </Button>
          ) : null}
          {canReturn ? (
            <Link href={`/returns/new?saleId=${sale.id}`}>
              <Button>
                <Undo2 className="h-4 w-4" />
                Return Products
              </Button>
            </Link>
          ) : null}
          <Button variant="outline" onClick={handleA4Bill} disabled={busy} leftIcon={<FileDown className="h-4 w-4" />}>
            Print A4 bill
          </Button>
          <Button variant="ghost" onClick={handleReprint} disabled={busy} leftIcon={<Printer className="h-4 w-4" />}>
            Thermal receipt
          </Button>
          {canRetry ? (
            <Button variant="outline" onClick={handleRetry} disabled={busy}>
              <RefreshCw className="h-4 w-4" />
              Retry sync
            </Button>
          ) : null}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={pay.variant}>{pay.label}</Badge>
        <SaleReturnStatusBadge status={sale.returnStatus} />
        <SyncBadge status={sale.syncStatus} />
        {sale.quickbooksDocumentType ? (
          <Badge variant="primary">
            {sale.quickbooksDocumentType === 'SALES_RECEIPT' ? 'Sales Receipt' : 'Invoice'}
          </Badge>
        ) : null}
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
        {/* Items */}
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/50 text-left text-muted-foreground">
                  <th className="px-4 py-3 font-medium">Item</th>
                  <th className="px-4 py-3 text-right font-medium">Price</th>
                  <th className="px-4 py-3 text-right font-medium">Qty</th>
                  <th className="px-4 py-3 text-right font-medium">Discount</th>
                  <th className="px-4 py-3 text-right font-medium">Total</th>
                </tr>
              </thead>
              <tbody>
                {sale.items.map((it) => (
                  <tr key={it.id} className="border-b border-border last:border-0">
                    <td className="px-4 py-3">
                      <div className="font-medium">{it.productName}</div>
                      {it.sku ? (
                        <div className="text-xs text-muted-foreground">{it.sku}</div>
                      ) : null}
                      {it.discountReason ? (
                        <div className="text-xs text-muted-foreground">Reason: {it.discountReason}</div>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 text-right">{formatMoney(it.unitPrice)}</td>
                    <td className="px-4 py-3 text-right">{it.quantity}</td>
                    <td className="px-4 py-3 text-right">
                      {it.discountAmount > 0 ? (
                        <span className="text-success">-{formatMoney(it.discountAmount)}</span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right font-medium">{formatMoney(it.lineTotal)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        {/* Summary + payments + QB */}
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Summary</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <Row label="Subtotal" value={formatMoney(sale.subtotal)} />
              <Row label="Product discount" value={`-${formatMoney(sale.totalDiscount)}`} />
              {sale.orderDiscountAmount > 0 ? (
                <Row label="Order discount" value={`-${formatMoney(sale.orderDiscountAmount)}`} />
              ) : null}
              <Row label="Tax / VAT" value={formatMoney(sale.taxAmount)} />
              <div className="flex items-center justify-between border-t border-border pt-2 text-base font-semibold">
                <span>Total</span>
                <span>{formatMoney(sale.total)}</span>
              </div>
              <Row label="Paid" value={formatMoney(sale.paidAmount)} />
              {sale.balanceAmount > 0 ? (
                <div className="flex items-center justify-between font-medium text-danger">
                  <span>Balance</span>
                  <span>{formatMoney(sale.balanceAmount)}</span>
                </div>
              ) : null}
              {sale.paymentDueDate ? (
                <Row label="Payment due" value={formatDay(sale.paymentDueDate)} />
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>QuickBooks</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <Row
                label="Document"
                value={
                  sale.quickbooksDocumentType === 'SALES_RECEIPT'
                    ? 'Sales Receipt'
                    : sale.quickbooksDocumentType === 'INVOICE'
                      ? 'Invoice'
                      : '—'
                }
              />
              <Row label="Document ID" value={sale.quickbooksDocumentId ?? 'Not synced'} />
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Status</span>
                <SyncBadge status={sale.syncStatus} />
              </div>
              {sale.syncError ? <p className="text-xs text-danger">{sale.syncError}</p> : null}
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Payments received — full width under the items, because on a credit sale
          this is a history to read across (when, how, how much), not a figure to
          glance at. The Summary card keeps the totals. */}
      <Card className="overflow-hidden">
        <CardHeader>
          <CardTitle>Payments received</CardTitle>
        </CardHeader>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50 text-left text-muted-foreground">
                <th className="px-4 py-3 font-medium">Date &amp; time</th>
                <th className="px-4 py-3 font-medium">Method</th>
                <th className="px-4 py-3 font-medium">Reference</th>
                <th className="px-4 py-3 text-right font-medium">Amount</th>
              </tr>
            </thead>
            <tbody>
              {sale.payments.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-4 py-10 text-center text-muted-foreground">
                    {sale.balanceAmount > 0
                      ? 'Nothing received yet — this sale is entirely on credit.'
                      : 'No payments recorded.'}
                  </td>
                </tr>
              ) : (
                sale.payments.map((p) => (
                  <tr key={p.id} className="border-b border-border last:border-0">
                    {/* Date and time both: two instalments on one day are only
                        told apart by the time they came in. */}
                    <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">
                      {formatDateTime(p.createdAt)}
                    </td>
                    <td className="px-4 py-3">{paymentMethodLabel(p.method)}</td>
                    <td className="px-4 py-3 text-muted-foreground">{p.reference ?? '—'}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-right font-medium">
                      {formatMoney(p.amount)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
            {sale.payments.length > 1 ? (
              // Only earns its row once there is more than one payment to add up.
              <tfoot>
                <tr className="border-t border-border bg-muted/50">
                  <td className="px-4 py-3 font-medium" colSpan={3}>
                    Total received
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-right font-medium">
                    {formatMoney(sale.paidAmount)}
                  </td>
                </tr>
              </tfoot>
            ) : null}
          </table>
        </div>
      </Card>

      {/* Returns against this sale */}
      {returns.length > 0 ? (
        <Card className="overflow-hidden">
          <CardHeader>
            <CardTitle>Returns</CardTitle>
          </CardHeader>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/50 text-left text-muted-foreground">
                  <th className="px-4 py-3 font-medium">Return</th>
                  <th className="px-4 py-3 font-medium">Date</th>
                  <th className="px-4 py-3 text-right font-medium">Items</th>
                  <th className="px-4 py-3 text-right font-medium">Refund</th>
                  <th className="px-4 py-3 font-medium">Method</th>
                  <th className="px-4 py-3 font-medium">Created by</th>
                  <th className="px-4 py-3 font-medium">Approved by</th>
                  <th className="px-4 py-3 font-medium">Sync</th>
                  <th className="px-4 py-3 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {returns.map((r) => (
                  <tr key={r.id} className="border-b border-border last:border-0">
                    <td className="px-4 py-3">
                      <Link href={`/returns/${r.id}`} className="font-medium text-primary hover:underline">
                        {r.returnNumber}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {formatDateTime(r.completedAt ?? r.createdAt)}
                    </td>
                    <td className="px-4 py-3 text-right">{r.items.length}</td>
                    <td className="px-4 py-3 text-right font-medium">{formatMoney(r.refundTotal)}</td>
                    <td className="px-4 py-3">{r.refundMethod ? paymentMethodLabel(r.refundMethod) : '—'}</td>
                    <td className="px-4 py-3">{r.createdBy?.name ?? '—'}</td>
                    <td className="px-4 py-3">{r.approvedBy?.name ?? '—'}</td>
                    <td className="px-4 py-3">
                      <SyncBadge status={r.syncStatus} />
                    </td>
                    <td className="px-4 py-3">
                      <Link href={`/returns/${r.id}`}>
                        <Button variant="ghost" size="sm">
                          View
                        </Button>
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}

      {session ? (
        <RecordPaymentDialog
          session={session}
          saleId={sale.id}
          saleNumber={sale.saleNumber}
          outstanding={sale.balanceAmount}
          open={payOpen}
          onClose={() => setPayOpen(false)}
          onRecorded={() => setReloadKey((k) => k + 1)}
        />
      ) : null}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-foreground">{value}</span>
    </div>
  );
}
