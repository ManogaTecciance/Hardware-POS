'use client';

import { ExternalLink, Info, Wallet } from 'lucide-react';

import { DetailRow } from '@/components/suppliers/supplier-detail';
import { SupplierEmptyState } from '@/components/suppliers/supplier-states';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatBalance, formatDate } from '@/lib/suppliers/format';
import type { Supplier } from '@/lib/suppliers/types';

/**
 * Read-only mirror of QuickBooks Online financials. AxloPOS never edits these
 * values here — the source label makes that explicit, and unavailable data
 * renders as an empty state rather than fabricated numbers.
 */
export function SupplierFinancialSummaryTab({
  supplier,
  canViewFinancials,
  onMapQuickBooks,
}: {
  supplier: Supplier;
  canViewFinancials: boolean;
  onMapQuickBooks: () => void;
}) {
  if (!canViewFinancials) {
    return (
      <Card>
        <SupplierEmptyState
          icon={Wallet}
          title="You don’t have access to financial details"
          description="Financial summaries are available to owners, purchasing managers, and accountants."
        />
      </Card>
    );
  }

  const fin = supplier.financials;

  if (!fin.available) {
    return (
      <Card>
        <SupplierEmptyState
          icon={Wallet}
          title="This supplier is not connected to QuickBooks"
          description="Map the supplier to a QuickBooks vendor to see outstanding balances, open bills, and payment history."
          action={<Button size="sm" onClick={onMapQuickBooks}>Map vendor</Button>}
        />
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 rounded-xl border border-info/30 bg-info-soft px-3 py-2 text-xs text-info">
        <Info className="h-4 w-4 shrink-0" aria-hidden />
        <span>Financial data from QuickBooks Online. AxloPOS cannot change these balances.</span>
      </div>

      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>Financial summary</CardTitle>
          {fin.quickbooksUrl ? (
            <a
              href={fin.quickbooksUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
            >
              Open in QuickBooks <ExternalLink className="h-3.5 w-3.5" aria-hidden />
            </a>
          ) : null}
        </CardHeader>
        <CardContent>
          <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
            <DetailRow label="Outstanding payable" value={formatBalance(fin.outstandingBalance)} />
            <DetailRow
              label="Overdue balance"
              value={
                <span className={fin.overdueBalance && fin.overdueBalance > 0 ? 'text-danger' : undefined}>
                  {formatBalance(fin.overdueBalance)}
                </span>
              }
            />
            <DetailRow label="Open bills" value={fin.openBills ?? '—'} />
            <DetailRow label="Last payment" value={formatDate(fin.lastPaymentAt)} />
            <DetailRow label="Last payment amount" value={fin.lastPaymentAmount != null ? formatBalance(fin.lastPaymentAmount) : '—'} />
            <DetailRow label="Total purchased" value={fin.totalPurchased != null ? formatBalance(fin.totalPurchased) : '—'} />
            <DetailRow label="Payment terms" value={fin.paymentTerms ?? '—'} />
            <DetailRow label="QuickBooks vendor" value={fin.quickbooksVendorName ?? '—'} />
            <DetailRow label="Last synced" value={formatDate(fin.lastSyncedAt)} />
          </dl>
        </CardContent>
      </Card>
    </div>
  );
}
