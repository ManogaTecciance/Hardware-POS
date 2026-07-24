'use client';

import * as React from 'react';
import { ExternalLink, RefreshCw } from 'lucide-react';

import { SupplierActivityChart } from '@/components/suppliers/supplier-activity-chart';
import { DetailRow } from '@/components/suppliers/supplier-detail';
import { SupplierEmptyState } from '@/components/suppliers/supplier-states';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { Session } from '@/lib/auth';
import { formatBalance, formatDate } from '@/lib/suppliers/format';
import {
  fetchSupplierProducts,
  fetchSupplierPurchasePoints,
  fetchSupplierPurchases,
} from '@/lib/suppliers/suppliers-api';
import { computePurchaseSummary } from '@/lib/suppliers/view-models';
import { COMMUNICATION_LABELS, QB_STATUS_LABELS, SUPPLIER_STATUS_LABELS, type Supplier, type SupplierPurchasePoint } from '@/lib/suppliers/types';

export function SupplierOverviewTab({
  session,
  supplier,
  onOpenTab,
  onMapQuickBooks,
}: {
  session: Session;
  supplier: Supplier;
  onOpenTab: (tab: string) => void;
  onMapQuickBooks: () => void;
}) {
  const [points, setPoints] = React.useState<SupplierPurchasePoint[]>([]);
  const [productCount, setProductCount] = React.useState<number | null>(null);
  const [purchaseCount, setPurchaseCount] = React.useState<number | null>(null);
  const [lastPurchaseAt, setLastPurchaseAt] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(0);

  React.useEffect(() => {
    let cancelled = false;
    fetchSupplierPurchasePoints(session, supplier.id).then((p) => !cancelled && setPoints(p)).catch(() => undefined);
    fetchSupplierProducts(session, supplier.id).then((p) => !cancelled && setProductCount(p.length)).catch(() => undefined);
    fetchSupplierPurchases(session, supplier.id)
      .then((rows) => {
        if (cancelled) return;
        setPurchaseCount(rows.length);
        const summary = computePurchaseSummary(rows);
        setLastPurchaseAt(summary.lastPurchaseAt);
        setPending(summary.pendingActivityCount);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [session, supplier.id]);

  const fin = supplier.financials;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Supplier information</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
            <DetailRow label="Legal name" value={supplier.legalName ?? supplier.name} />
            <DetailRow label="Status" value={SUPPLIER_STATUS_LABELS[supplier.status]} />
            <DetailRow label="Phone" value={supplier.phone ?? '—'} />
            <DetailRow label="Email" value={supplier.email ?? '—'} />
            <DetailRow label="Registration no." value={supplier.registrationNumber ?? '—'} />
            <DetailRow label="VAT / TIN" value={supplier.vatNumber ?? '—'} />
            <DetailRow
              label="Preferred communication"
              value={supplier.preferredCommunication ? COMMUNICATION_LABELS[supplier.preferredCommunication] : '—'}
            />
            <DetailRow label="City" value={supplier.city ?? '—'} />
            {supplier.address ? (
              <DetailRow className="sm:col-span-2" label="Address" value={<span className="whitespace-pre-line">{supplier.address}</span>} />
            ) : null}
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Purchasing terms</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
            <DetailRow label="Payment terms" value={supplier.paymentTerms ?? '—'} />
            <DetailRow label="Credit limit" value={supplier.creditLimit != null ? formatBalance(supplier.creditLimit, '—') : '—'} />
            <DetailRow label="Lead time" value={supplier.defaultLeadTimeDays != null ? `${supplier.defaultLeadTimeDays} days` : '—'} />
            <DetailRow label="Min. order value" value={supplier.minOrderValue != null ? formatBalance(supplier.minOrderValue, '—') : '—'} />
            <DetailRow label="Currency" value={supplier.defaultCurrency ?? 'LKR'} />
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Operational summary</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
            <DetailRow label="Products supplied" value={productCount ?? '—'} />
            <DetailRow
              label="Categories"
              value={supplier.categories.length ? supplier.categories.map((c) => c.name).join(', ') : '—'}
            />
            <DetailRow label="Purchase records" value={purchaseCount ?? '—'} />
            <DetailRow label="Last purchase" value={formatDate(lastPurchaseAt)} />
            <DetailRow label="Outstanding balance" value={fin.available ? formatBalance(fin.outstandingBalance) : 'Not synced'} />
            <DetailRow label="Pending activity" value={pending} />
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>QuickBooks summary</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
            <DetailRow label="Mapped vendor" value={supplier.quickbooks.quickbooksVendorName ?? 'Not mapped'} />
            <DetailRow label="Connection" value={QB_STATUS_LABELS[supplier.quickbooks.status]} />
            <DetailRow label="Last sync" value={formatDate(supplier.quickbooks.lastSyncedAt)} />
          </dl>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={onMapQuickBooks} leftIcon={<RefreshCw className="h-4 w-4" />}>
              {supplier.quickbooks.status === 'NOT_CONNECTED' ? 'Map vendor' : 'View mapping'}
            </Button>
            {supplier.financials.quickbooksUrl ? (
              <a
                href={supplier.financials.quickbooksUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex h-9 items-center gap-1.5 rounded-xl px-3 text-sm text-primary hover:underline"
              >
                Open in QuickBooks <ExternalLink className="h-3.5 w-3.5" aria-hidden />
              </a>
            ) : null}
          </div>
        </CardContent>
      </Card>

      {points.length > 0 ? (
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Purchase activity</CardTitle>
          </CardHeader>
          <CardContent>
            <SupplierActivityChart points={points} />
          </CardContent>
        </Card>
      ) : null}

      <Card className="lg:col-span-2">
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>Internal notes</CardTitle>
          <Button variant="ghost" size="sm" onClick={() => onOpenTab('documents')}>
            View all
          </Button>
        </CardHeader>
        <CardContent>
          {supplier.internalNotes ? (
            <p className="text-sm text-muted-foreground">{supplier.internalNotes}</p>
          ) : (
            <SupplierEmptyState title="No internal notes yet" description="Notes are only visible to your team." />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
