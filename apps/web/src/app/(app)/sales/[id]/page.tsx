'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import * as React from 'react';
import { ArrowLeft, FileDown, Printer, RefreshCw, Undo2 } from 'lucide-react';

import { paymentMethodLabel, saleReadsAsPaid, saleStatusLabel } from '@hardware-pos/shared';

import { SyncBadge } from '@/components/quickbooks/sync-badge';
import { SaleReturnStatusBadge } from '@/components/returns/status-badges';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useAuth } from '@/lib/auth';
import { Permission } from '@/lib/permissions';
import { useEffectiveProfile } from '@/lib/platform-profile';
import { reprintCustomerReceipt } from '@/lib/receipt-print';
import { fetchSaleReturns, type ReturnDetail } from '@/lib/returns';
import { fetchSale, retrySaleSync, type PaymentStatusCode, type SaleDetail } from '@/lib/sales';
import { resolveDocumentSettingsPresentation } from '@/lib/settings/document-presentation';
import { formatMoney } from '@/lib/utils';

// Wording comes from PAYMENT_STATUS_LABELS so the detail page and the list can
// never word the same sale differently; only the colour is local.
const PAYMENT_STATUS_VARIANT: Record<PaymentStatusCode, 'success' | 'neutral' | 'danger'> = {
  PAID: 'success',
  PARTIAL: 'danger',
  UNPAID: 'danger',
  REFUNDED: 'neutral',
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
  // D96 — which printed document this workspace's settings are about.
  const { profile } = useEffectiveProfile();
  const view = resolveDocumentSettingsPresentation({
    capabilities: profile?.capabilities ?? null,
  });

  const [sale, setSale] = React.useState<SaleDetail | null>(null);
  const [returns, setReturns] = React.useState<ReturnDetail[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [reloadKey, setReloadKey] = React.useState(0);
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

  // A sale covered by an account settlement reads as paid, whatever its own
  // payment status says about what was tendered at the till.
  const payVariant = saleReadsAsPaid(sale.creditSettledAt, sale.markedPaidAt)
    ? 'success'
    : PAYMENT_STATUS_VARIANT[sale.paymentStatus];
  // A tenant with no accounting provider has nothing to retry: its sales carry no
  // external document type and are NOT_SYNCED rather than PENDING. The document-type
  // check states that intent explicitly instead of relying on the status alone.
  const hasExternalAccounting = sale.quickbooksDocumentType !== null;
  const canRetry =
    hasExternalAccounting && (sale.syncStatus === 'FAILED' || sale.syncStatus === 'PENDING');
  const canReturn =
    sale.status === 'COMPLETED' &&
    sale.returnStatus !== 'FULLY_RETURNED' &&
    hasPermission(Permission.RETURN_CREATE);

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
          {canReturn ? (
            <Link href={`/returns/new?saleId=${sale.id}`}>
              <Button>
                <Undo2 className="h-4 w-4" />
                Return Products
              </Button>
            </Link>
          ) : null}
          {/*
            * D96 — the A4 bill is the document whose letterhead, signature
            * block and stamp live on the Branding and Layout tabs. A
            * food-service workspace no longer has those controls, so offering
            * the document here would leave an operator with a signature block
            * they cannot populate or switch off. The thermal receipt stays:
            * that IS their document.
            *
            * Usability only. `/print/sales/[saleId]` is ungated and a typed URL
            * still renders it; the server is unchanged.
            */}
          {view.showA4SaleDocument ? (
            <Button variant="outline" onClick={handleA4Bill} disabled={busy} leftIcon={<FileDown className="h-4 w-4" />}>
              Print A4 bill
            </Button>
          ) : null}
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
        <Badge variant={payVariant}>
          {saleStatusLabel(sale.paymentStatus, sale.creditSettledAt, sale.markedPaidAt)}
        </Badge>
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

          {/*
            External-accounting panel. `quickbooksDocumentType` is set when the sale
            is created for any tenant with an accounting provider, so a QuickBooks
            tenant always has one and this card is unchanged for them. A tenant with
            AccountingProviderKind.NONE has null, and must not be shown a
            "QuickBooks — Not synced" panel about a system it does not use.
          */}
          {sale.quickbooksDocumentType ? (
            <Card>
              <CardHeader>
                <CardTitle>QuickBooks</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <Row
                  label="Document"
                  value={sale.quickbooksDocumentType === 'SALES_RECEIPT' ? 'Sales Receipt' : 'Invoice'}
                />
                <Row label="Document ID" value={sale.quickbooksDocumentId ?? 'Not synced'} />
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Status</span>
                  <SyncBadge status={sale.syncStatus} />
                </div>
                {sale.syncError ? <p className="text-xs text-danger">{sale.syncError}</p> : null}
              </CardContent>
            </Card>
          ) : null}
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
                    {sale.creditSettledAt
                      ? 'Nothing was tendered here — covered when the customer settled their account.'
                      : sale.balanceAmount > 0
                        ? 'Nothing received yet — this sale is on the customer\u2019s credit account.'
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
