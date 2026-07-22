'use client';

import { ReceiptText } from 'lucide-react';
import * as React from 'react';

import { SupplierEmptyState, SupplierErrorState } from '@/components/suppliers/supplier-states';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import type { Session } from '@/lib/auth';
import { formatBalance, formatDate } from '@/lib/suppliers/format';
import { fetchSupplierPurchases } from '@/lib/suppliers/suppliers-api';
import { PURCHASE_STATUS_LABELS, type PurchaseStatus, type SupplierPurchase } from '@/lib/suppliers/types';

// NOTE(backend): Purchase orders are not yet a first-class subsystem. When a PO
// module ships, replace this adapter call with the live endpoint and remove the
// production-safe empty state fallback below.
const STATUS_VARIANT: Record<PurchaseStatus, BadgeProps['variant']> = {
  DRAFT: 'neutral',
  SENT: 'info',
  PARTIALLY_RECEIVED: 'warning',
  RECEIVED: 'success',
  CANCELLED: 'neutral',
  OVERDUE: 'danger',
};

export function SupplierPurchaseHistoryTab({ session, supplierId }: { session: Session; supplierId: string }) {
  const [rows, setRows] = React.useState<SupplierPurchase[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchSupplierPurchases(session, supplierId)
      .then((r) => !cancelled && setRows(r))
      .catch((err: unknown) => !cancelled && setError(err instanceof Error ? err.message : 'Could not load purchase history.'))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [session, supplierId]);

  React.useEffect(() => load(), [load]);

  if (loading) return <Card><div className="p-6 text-sm text-muted-foreground">Loading purchase history…</div></Card>;
  if (error) return <Card><SupplierErrorState message={error} onRetry={load} /></Card>;

  if (rows.length === 0) {
    return (
      <Card>
        <SupplierEmptyState
          icon={ReceiptText}
          title="No purchasing history is available for this supplier yet"
          description="Purchase orders and received goods will appear here once purchasing is recorded against this supplier."
        />
      </Card>
    );
  }

  return (
    <Card className="overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/50 text-left text-muted-foreground">
              <th scope="col" className="px-4 py-3 font-medium">Reference</th>
              <th scope="col" className="px-4 py-3 font-medium">Date</th>
              <th scope="col" className="hidden px-4 py-3 font-medium md:table-cell">Invoice no.</th>
              <th scope="col" className="hidden px-4 py-3 text-right font-medium sm:table-cell">Items</th>
              <th scope="col" className="px-4 py-3 text-right font-medium">Total</th>
              <th scope="col" className="hidden px-4 py-3 text-right font-medium lg:table-cell">Received</th>
              <th scope="col" className="px-4 py-3 text-right font-medium">Balance</th>
              <th scope="col" className="px-4 py-3 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.id} className="border-b border-border last:border-0 hover:bg-muted/30">
                <td className="px-4 py-3 font-medium text-foreground">{p.reference}</td>
                <td className="px-4 py-3 text-muted-foreground">{formatDate(p.date)}</td>
                <td className="hidden px-4 py-3 text-muted-foreground md:table-cell">{p.supplierInvoiceNumber ?? '—'}</td>
                <td className="hidden px-4 py-3 text-right sm:table-cell">{p.itemCount}</td>
                <td className="px-4 py-3 text-right tabular-nums">{formatBalance(p.total, '—')}</td>
                <td className="hidden px-4 py-3 text-right tabular-nums lg:table-cell">{formatBalance(p.received, '—')}</td>
                <td className="px-4 py-3 text-right tabular-nums">{formatBalance(p.balance, '—')}</td>
                <td className="px-4 py-3">
                  <Badge variant={STATUS_VARIANT[p.status]}>{PURCHASE_STATUS_LABELS[p.status]}</Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
