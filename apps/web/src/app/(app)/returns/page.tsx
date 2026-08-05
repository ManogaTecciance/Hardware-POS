'use client';

import Link from 'next/link';
import { Undo2 } from 'lucide-react';
import * as React from 'react';

import { PageHeader } from '@/components/page-header';
import { SyncBadge } from '@/components/quickbooks/sync-badge';
import { ReturnStatusBadge } from '@/components/returns/status-badges';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { useAuth } from '@/lib/auth';
import { fetchReturns, type ReturnListItem, type ReturnsQuery } from '@/lib/returns';
import { formatMoney } from '@/lib/utils';
import type { ReturnStatusCode } from '@hardware-pos/shared';
import type { SyncStatusCode } from '@/lib/sales';

const PAGE_SIZES = [20, 30, 40, 50];

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('en-LK', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function ReturnsPage() {
  const { session } = useAuth();
  const [rows, setRows] = React.useState<ReturnListItem[]>([]);
  const [total, setTotal] = React.useState(0);
  const [page, setPage] = React.useState(1);
  const [pageSize, setPageSize] = React.useState(20);
  const [search, setSearch] = React.useState('');
  const [debounced, setDebounced] = React.useState('');
  const [status, setStatus] = React.useState<ReturnStatusCode | ''>('');
  const [syncStatus, setSyncStatus] = React.useState<SyncStatusCode | ''>('');
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  React.useEffect(() => {
    setPage(1);
  }, [debounced, status, syncStatus, pageSize]);

  React.useEffect(() => {
    if (!session) return;
    let cancelled = false;
    setLoading(true);
    const query: ReturnsQuery = {
      page,
      pageSize,
      search: debounced || undefined,
      status: status || undefined,
      syncStatus: syncStatus || undefined,
    };
    fetchReturns(session, query)
      .then((res) => {
        if (cancelled) return;
        setRows(res.items);
        setTotal(res.total);
        setError(null);
      })
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : 'Failed to load returns'))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [session, page, pageSize, debounced, status, syncStatus]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Returns"
        description="Product returns and refunds against completed sales."
        actions={
          <Link href="/sales" className="text-sm font-medium text-primary hover:underline">
            Start a return from a sale →
          </Link>
        }
      />

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-56 flex-1">
          <Input
            placeholder="Search return / sale number or customer…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Select
          className="w-auto"
          value={status}
          onChange={(e) => setStatus(e.target.value as ReturnStatusCode | '')}
        >
          <option value="">All statuses</option>
          <option value="COMPLETED">Completed</option>
          <option value="PENDING_APPROVAL">Pending approval</option>
          <option value="CANCELLED">Cancelled</option>
          <option value="FAILED">Failed</option>
        </Select>
        <Select
          className="w-auto"
          value={syncStatus}
          onChange={(e) => setSyncStatus(e.target.value as SyncStatusCode | '')}
        >
          <option value="">All sync</option>
          <option value="PENDING">Waiting for QuickBooks</option>
          <option value="SYNCED">Synced</option>
          <option value="FAILED">Sync failed</option>
        </Select>
      </div>

      {error ? (
        <div className="rounded-xl bg-danger-soft px-4 py-3 text-sm font-medium text-danger">{error}</div>
      ) : null}

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50 text-left text-muted-foreground">
                <th className="px-4 py-3 font-medium">Return</th>
                <th className="px-4 py-3 font-medium">Original sale</th>
                <th className="px-4 py-3 font-medium">Date</th>
                <th className="px-4 py-3 font-medium">Customer</th>
                <th className="px-4 py-3 font-medium">Cashier</th>
                <th className="px-4 py-3 text-right font-medium">Items</th>
                <th className="px-4 py-3 text-right font-medium">Refund</th>
                <th className="px-4 py-3 font-medium">Method</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Sync</th>
                <th className="px-4 py-3 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={11} className="px-4 py-10 text-center text-muted-foreground">
                    Loading…
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={11} className="px-4 py-12 text-center">
                    <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-muted">
                      <Undo2 className="h-6 w-6 text-muted-foreground" />
                    </div>
                    <p className="mt-3 text-sm text-muted-foreground">No returns yet.</p>
                  </td>
                </tr>
              ) : (
                rows.map((r) => (
                  <tr key={r.id} className="border-b border-border last:border-0 hover:bg-muted/30">
                    <td className="px-4 py-3">
                      <Link
                        href={`/returns/${r.id}`}
                        className="font-medium text-primary hover:underline"
                      >
                        {r.returnNumber}
                      </Link>
                    </td>
                    <td className="px-4 py-3">
                      <Link
                        href={`/sales/${r.originalSaleId}`}
                        className="text-primary hover:underline"
                      >
                        {r.originalSaleNumber}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{formatDate(r.createdAt)}</td>
                    <td className="px-4 py-3">{r.customerName ?? '—'}</td>
                    <td className="px-4 py-3">{r.cashierName ?? '—'}</td>
                    <td className="px-4 py-3 text-right">{r.itemCount}</td>
                    <td className="px-4 py-3 text-right font-medium">{formatMoney(r.refundTotal)}</td>
                    <td className="px-4 py-3">{r.refundMethod ? humanize(r.refundMethod) : '—'}</td>
                    <td className="px-4 py-3">
                      <ReturnStatusBadge status={r.status} />
                    </td>
                    <td className="px-4 py-3">
                      {/*
                        A QuickBooks sync status only means something for a return
                        that was filed with QuickBooks. A tenant with no accounting
                        provider sees their local document kind instead of a
                        permanent "Not synced".
                      */}
                      {r.quickbooksDocumentType ? (
                        <SyncBadge status={r.syncStatus} />
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          {r.documentKind === 'CREDIT_NOTE' ? 'Credit note' : 'Refund receipt'}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <Link href={`/returns/${r.id}`}>
                        <Button variant="ghost" size="sm">
                          View
                        </Button>
                      </Link>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
        <div className="flex items-center gap-2">
          <span>Rows per page</span>
          <Select
            className="w-auto"
            value={String(pageSize)}
            onChange={(e) => setPageSize(Number(e.target.value))}
          >
            {PAGE_SIZES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex items-center gap-3">
          <span>
            {from}–{to} of {total}
          </span>
          <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            Prev
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= totalPages}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </Button>
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
