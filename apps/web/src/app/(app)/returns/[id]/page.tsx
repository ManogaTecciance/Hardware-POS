'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ArrowLeft, FileDown, Printer, RefreshCw } from 'lucide-react';
import * as React from 'react';

import { SyncBadge } from '@/components/quickbooks/sync-badge';
import { RefundStatusBadge, ReturnStatusBadge } from '@/components/returns/status-badges';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useAuth } from '@/lib/auth';
import {
  fetchReturn,
  fetchReturnDocument,
  generateReturnReceipt,
  retryReturnSync,
  type ReturnDetail,
} from '@/lib/returns';
import { formatMoney } from '@/lib/utils';
import {
  ITEM_CONDITION_LABELS,
  RETURN_REASON_LABELS,
  STOCK_DISPOSITION_LABELS,
} from '@hardware-pos/shared';

function Row({ label, value, strong }: { label: string; value: React.ReactNode; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span className={strong ? 'font-semibold' : 'text-foreground'}>{value}</span>
    </div>
  );
}

export default function ReturnDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { session } = useAuth();
  const [ret, setRet] = React.useState<ReturnDetail | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(() => {
    if (!session) return;
    setLoading(true);
    fetchReturn(session, id)
      .then((r) => {
        setRet(r);
        setError(null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load return'))
      .finally(() => setLoading(false));
  }, [session, id]);

  React.useEffect(load, [load]);

  const printA4Note = async () => {
    if (!session || !ret) return;
    setBusy(true);
    try {
      const { html } = await fetchReturnDocument(session, ret.id);
      const w = window.open('', '_blank', 'width=880,height=1000');
      if (w) {
        w.document.write(html);
        w.document.close();
        w.focus();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not generate the A4 note');
    } finally {
      setBusy(false);
    }
  };

  const printReceipt = async () => {
    if (!session || !ret) return;
    setBusy(true);
    try {
      const { html } = await generateReturnReceipt(session, ret.id);
      const w = window.open('', '_blank', 'width=420,height=720');
      if (w) {
        w.document.write(html);
        w.document.close();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not generate receipt');
    } finally {
      setBusy(false);
    }
  };

  const retrySync = async () => {
    if (!session || !ret) return;
    setBusy(true);
    try {
      await retryReturnSync(session, ret.id);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Retry failed');
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return <div className="text-sm text-muted-foreground">Loading…</div>;
  }
  if (error && !ret) {
    return <div className="rounded-xl bg-danger-soft px-4 py-3 text-sm font-medium text-danger">{error}</div>;
  }
  if (!ret) return null;

  const remaining = ret.originalSale.total - ret.originalSale.returnedAmount;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link
            href="/returns"
            className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" /> Returns
          </Link>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">{ret.returnNumber}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Against sale{' '}
            <Link href={`/sales/${ret.originalSale.id}`} className="text-primary hover:underline">
              {ret.originalSale.saleNumber}
            </Link>{' '}
            · {new Date(ret.createdAt).toLocaleString('en-LK')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={printReceipt} disabled={busy}>
            <Printer className="h-4 w-4" /> Print receipt
          </Button>
          <Button variant="outline" onClick={printA4Note} disabled={busy}>
            <FileDown className="h-4 w-4" /> A4 note
          </Button>
          {ret.syncStatus === 'FAILED' ? (
            <Button variant="outline" onClick={retrySync} disabled={busy}>
              <RefreshCw className="h-4 w-4" /> Retry sync
            </Button>
          ) : null}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <ReturnStatusBadge status={ret.status} />
        <RefundStatusBadge status={ret.refundStatus} />
        <SyncBadge status={ret.syncStatus} />
        {ret.quickbooksDocumentType ? (
          <Badge variant="primary">
            {ret.quickbooksDocumentType === 'CREDIT_MEMO' ? 'Credit Memo' : 'Refund Receipt'}
          </Badge>
        ) : null}
      </div>

      {error ? (
        <div className="rounded-xl bg-danger-soft px-4 py-3 text-sm font-medium text-danger">{error}</div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
        {/* Returned items */}
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/50 text-left text-muted-foreground">
                  <th className="px-4 py-3 font-medium">Product</th>
                  <th className="px-4 py-3 text-right font-medium">Qty</th>
                  <th className="px-4 py-3 text-right font-medium">Unit price</th>
                  <th className="px-4 py-3 text-right font-medium">Refund</th>
                </tr>
              </thead>
              <tbody>
                {ret.items.map((it) => (
                  <tr key={it.id} className="border-b border-border last:border-0">
                    <td className="px-4 py-3">
                      <div className="font-medium">{it.productNameSnapshot}</div>
                      {it.skuSnapshot ? (
                        <div className="text-xs text-muted-foreground">{it.skuSnapshot}</div>
                      ) : null}
                      <div className="mt-1 text-xs text-muted-foreground">
                        {RETURN_REASON_LABELS[it.returnReason]} · {ITEM_CONDITION_LABELS[it.itemCondition]}{' '}
                        · {STOCK_DISPOSITION_LABELS[it.stockDisposition]}
                      </div>
                      {it.note ? <div className="mt-1 text-xs italic text-muted-foreground">“{it.note}”</div> : null}
                    </td>
                    <td className="px-4 py-3 text-right">{it.returnQuantity}</td>
                    <td className="px-4 py-3 text-right">{formatMoney(it.originalUnitPrice)}</td>
                    <td className="px-4 py-3 text-right font-medium">{formatMoney(it.refundableAmount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        {/* Right column */}
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Refund summary</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <Row label="Returned subtotal" value={formatMoney(ret.subtotal)} />
              <Row
                label="Product discount adj."
                value={<span className="text-success">-{formatMoney(ret.productDiscountAdjustment)}</span>}
              />
              {ret.orderDiscountAdjustment > 0 ? (
                <Row
                  label="Order discount adj."
                  value={<span className="text-success">-{formatMoney(ret.orderDiscountAdjustment)}</span>}
                />
              ) : null}
              <Row label="Tax adjustment" value={formatMoney(ret.taxAdjustment)} />
              <div className="my-1 border-t border-border" />
              <Row label="Refund total" value={<span className="text-danger">{formatMoney(ret.refundTotal)}</span>} strong />
              <Row label="Refund method" value={ret.refundMethod ? humanize(ret.refundMethod) : '—'} />
              {ret.refundReference ? <Row label="Reference" value={ret.refundReference} /> : null}
              <Row label="Remaining sale value" value={formatMoney(remaining)} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <Row label="Customer" value={ret.customer?.name ?? 'Walk-in'} />
              <Row label="Cashier" value={ret.createdBy?.name ?? '—'} />
              <Row label="Approved by" value={ret.approvedBy?.name ?? 'Not required'} />
              <Row label="Branch" value={ret.branch?.name ?? '—'} />
              {ret.register ? <Row label="Register" value={ret.register.name} /> : null}
              {ret.notes ? <Row label="Notes" value={ret.notes} /> : null}
            </CardContent>
          </Card>

          {/*
            Hidden for a tenant with no accounting provider, where
            `quickbooksDocumentType` is null. Previously a null fell through to
            "Refund Receipt" inside a card headed "QuickBooks" — a label about a
            system the tenant does not use. A QuickBooks tenant always has a
            document type, so their view is unchanged.
          */}
          {ret.quickbooksDocumentType ? (
            <Card>
              <CardHeader>
                <CardTitle>QuickBooks</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <Row
                  label="Document"
                  value={ret.quickbooksDocumentType === 'CREDIT_MEMO' ? 'Credit Memo' : 'Refund Receipt'}
                />
                <Row label="Document ID" value={ret.quickbooksDocumentId ?? '—'} />
                <Row label="Sync status" value={<SyncBadge status={ret.syncStatus} />} />
                {ret.syncError ? (
                  <div className="rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger">
                    {ret.syncError}
                  </div>
                ) : null}
              </CardContent>
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function humanize(value: string): string {
  return value
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/^\w/, (c) => c.toUpperCase());
}
