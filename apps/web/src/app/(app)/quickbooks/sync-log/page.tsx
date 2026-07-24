'use client';

import * as React from 'react';

import { SyncBadge } from '@/components/quickbooks/sync-badge';
import { Card, CardContent } from '@/components/ui/card';
import { useQuickBooks, type SyncState } from '@/lib/quickbooks';
import { formatQbTime } from '@/lib/quickbooks';
import { cn } from '@/lib/utils';

const FILTERS: { key: 'ALL' | SyncState; label: string }[] = [
  { key: 'ALL', label: 'All' },
  { key: 'SYNCED', label: 'Synced' },
  { key: 'FAILED', label: 'Failed' },
  { key: 'PENDING', label: 'Pending' },
];

const TYPE_LABEL: Record<string, string> = {
  PRODUCT_PULL: 'Product pull',
  SALE_PUSH: 'Sale push',
  RETURN_PUSH: 'Return push',
  CUSTOMER_PULL: 'Customer pull',
  VENDOR_PULL: 'Vendor pull',
  CONNECTION: 'Connection',
};

export default function QuickBooksSyncLogPage() {
  const { state, loading } = useQuickBooks();
  const [filter, setFilter] = React.useState<'ALL' | SyncState>('ALL');

  const rows = state.log.filter((l) => filter === 'ALL' || l.status === filter);

  if (loading) {
    return (
      <Card>
        <CardContent className="py-16 text-center text-sm text-muted-foreground">
          Loading sync log…
        </CardContent>
      </Card>
    );
  }

  if (!state.connected) {
    return (
      <Card>
        <CardContent className="py-16 text-center text-sm text-muted-foreground">
          Connect QuickBooks to see the sync log.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={cn(
              'rounded-full px-3 py-1.5 text-sm font-medium transition-colors',
              filter === f.key
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted text-muted-foreground hover:bg-border',
            )}
          >
            {f.label}
          </button>
        ))}
      </div>

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50 text-left text-muted-foreground">
                <th className="px-4 py-3 font-medium">Time</th>
                <th className="px-4 py-3 font-medium">Type</th>
                <th className="px-4 py-3 font-medium">Direction</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Message</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((l) => (
                <tr
                  key={l.id}
                  className={cn(
                    'border-b border-border last:border-0',
                    l.status === 'FAILED' && 'bg-danger-soft/40',
                  )}
                >
                  <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">
                    {formatQbTime(l.tsISO)}
                  </td>
                  <td className="px-4 py-3">{TYPE_LABEL[l.type] ?? l.type}</td>
                  <td className="px-4 py-3 text-muted-foreground">{l.direction}</td>
                  <td className="px-4 py-3">
                    <SyncBadge status={l.status} />
                  </td>
                  <td className="px-4 py-3">{l.message}</td>
                </tr>
              ))}
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-12 text-center text-muted-foreground">
                    No log entries.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
