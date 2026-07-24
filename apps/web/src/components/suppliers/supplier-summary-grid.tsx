import { AlertTriangle, Clock, Truck, Wallet } from 'lucide-react';

import { formatBalance } from '@/lib/suppliers/format';
import type { SupplierSummaryMetrics } from '@/lib/suppliers/types';

import { SupplierMetricCard } from './supplier-metric-card';

/** The four clickable summary cards; each applies its related list filter. */
export function SupplierSummaryGrid({
  metrics,
  loading,
  activeKey,
  onSelect,
}: {
  metrics: SupplierSummaryMetrics | null;
  loading: boolean;
  activeKey: string | null;
  onSelect: (key: 'active' | 'outstanding' | 'pending' | 'attention') => void;
}) {
  const m = metrics;
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <SupplierMetricCard
        label="Active suppliers"
        value={m ? String(m.activeSuppliers) : '—'}
        hint={m && m.activeAddedThisMonth > 0 ? `${m.activeAddedThisMonth} added this month` : 'All active suppliers'}
        icon={Truck}
        tone="brand"
        loading={loading}
        active={activeKey === 'active'}
        onClick={() => onSelect('active')}
      />
      <SupplierMetricCard
        label="Outstanding payables"
        value={m ? formatBalance(m.outstandingPayables, 'Unavailable') : '—'}
        hint={
          m == null
            ? undefined
            : m.outstandingPayables == null
              ? 'Connect QuickBooks to see balances'
              : `Across ${m.outstandingSupplierCount} supplier${m.outstandingSupplierCount === 1 ? '' : 's'}`
        }
        icon={Wallet}
        tone="warning"
        loading={loading}
        active={activeKey === 'outstanding'}
        onClick={() => onSelect('outstanding')}
      />
      <SupplierMetricCard
        label="Pending purchase activity"
        value={m ? String(m.pendingPurchaseActivity) : '—'}
        hint={m && m.overduePurchaseActivity > 0 ? `${m.overduePurchaseActivity} overdue` : 'Open purchase records'}
        icon={Clock}
        tone="brand"
        loading={loading}
        active={activeKey === 'pending'}
        onClick={() => onSelect('pending')}
      />
      <SupplierMetricCard
        label="Needs attention"
        value={m ? String(m.needsAttention) : '—'}
        hint="Sync, documentation, or payment issues"
        icon={AlertTriangle}
        tone="danger"
        loading={loading}
        active={activeKey === 'attention'}
        onClick={() => onSelect('attention')}
      />
    </div>
  );
}
