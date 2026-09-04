'use client';

import Link from 'next/link';
import * as React from 'react';
import { Printer, ReceiptText, RefreshCw, Search, X } from 'lucide-react';

import { PageHeader } from '@/components/page-header';
import { SyncBadge } from '@/components/quickbooks/sync-badge';
import { SaleReturnStatusBadge } from '@/components/returns/status-badges';
import {
  DateRangeFilter,
  resolveDateRange,
  type DateRangeValue,
} from '@/components/sales/date-range-filter';
import { ExportMenu } from '@/components/sales/export-menu';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Tooltip } from '@/components/ui/tooltip';
import { useAuth } from '@/lib/auth';
import { reprintCustomerReceipt } from '@/lib/receipt-print';
import {
  downloadSalesReport,
  fetchSales,
  retrySaleSync,
  type PaymentStatusCode,
  type ReportFormat,
  type SaleListItem,
  type SalesQuery,
  type SyncStatusCode,
} from '@/lib/sales';
import { cn, formatMoney } from '@/lib/utils';

const PAGE_SIZES = [20, 30, 40, 50];

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-LK', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function PaymentStatusBadge({ status }: { status: PaymentStatusCode }) {
  const map: Record<
    PaymentStatusCode,
    { label: string; variant: 'success' | 'warning' | 'neutral' | 'danger' }
  > = {
    PAID: { label: 'Paid', variant: 'success' },
    PARTIAL: { label: 'Partially paid', variant: 'warning' },
    UNPAID: { label: 'Credit / Unpaid', variant: 'danger' },
    REFUNDED: { label: 'Refunded', variant: 'neutral' },
  };
  const { label, variant } = map[status];
  return <Badge variant={variant}>{label}</Badge>;
}

export default function SalesPage() {
  const { session } = useAuth();

  const [search, setSearch] = React.useState('');
  const [debouncedSearch, setDebouncedSearch] = React.useState('');
  const [dateRange, setDateRange] = React.useState<DateRangeValue>({ preset: 'ALL' });
  const [paymentStatus, setPaymentStatus] = React.useState<PaymentStatusCode | ''>('');
  const [syncStatus, setSyncStatus] = React.useState<SyncStatusCode | ''>('');
  const [page, setPage] = React.useState(1);
  const [pageSize, setPageSize] = React.useState(20);

  const [rows, setRows] = React.useState<SaleListItem[]>([]);
  const [total, setTotal] = React.useState(0);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [reloadKey, setReloadKey] = React.useState(0);
  const [exporting, setExporting] = React.useState<ReportFormat | null>(null);

  // Debounce the search box so we don't refetch on every keystroke. Collapse
  // internal whitespace runs too: the API matches with a literal `contains`,
  // so "x  x" would otherwise miss "x x".
  React.useEffect(() => {
    const t = window.setTimeout(() => setDebouncedSearch(search.replace(/\s+/g, ' ').trim()), 300);
    return () => window.clearTimeout(t);
  }, [search]);

  // Reset to page 1 whenever a filter changes.
  React.useEffect(() => {
    setPage(1);
  }, [debouncedSearch, dateRange, paymentStatus, syncStatus, pageSize]);

  /** The filters currently applied to the table (report exports reuse these). */
  const filterQuery = React.useMemo<Omit<SalesQuery, 'page' | 'pageSize'>>(
    () => ({
      search: debouncedSearch || undefined,
      paymentStatus: paymentStatus || undefined,
      syncStatus: syncStatus || undefined,
      ...resolveDateRange(dateRange),
    }),
    [debouncedSearch, paymentStatus, syncStatus, dateRange],
  );

  React.useEffect(() => {
    if (!session) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchSales(session, { page, pageSize, ...filterQuery })
      .then((res) => {
        if (cancelled) return;
        setRows(res.items);
        setTotal(res.total);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Could not load sales');
        setRows([]);
        setTotal(0);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [session, page, pageSize, filterQuery, reloadKey]);

  const handleExport = async (format: ReportFormat) => {
    if (!session) return;
    setExporting(format);
    setError(null);
    try {
      await downloadSalesReport(session, filterQuery, format);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Export failed');
    } finally {
      setExporting(null);
    }
  };

  const handleReprint = async (id: string) => {
    if (!session) return;
    setBusyId(id);
    try {
      await reprintCustomerReceipt(session, id);
    } catch {
      /* the print window handles its own errors */
    } finally {
      setBusyId(null);
    }
  };

  const handleRetry = async (id: string) => {
    if (!session) return;
    setBusyId(id);
    try {
      await retrySaleSync(session, id);
      setReloadKey((k) => k + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Retry failed');
    } finally {
      setBusyId(null);
    }
  };

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Sales"
        description="Completed sales, payment status, and QuickBooks sync."
        actions={
          <Link href="/pos" className="text-sm font-medium text-primary hover:underline">
            New sale →
          </Link>
        }
      />

      {/* Toolbar: filters on the left, report exports on the right. */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search sale number or customer…"
            className="pl-10 pr-9"
          />
          {search ? (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => setSearch('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          ) : null}
        </div>
        <DateRangeFilter value={dateRange} onChange={setDateRange} />
        <Select
          value={paymentStatus}
          onChange={(e) => setPaymentStatus(e.target.value as PaymentStatusCode | '')}
          className="w-auto"
        >
          <option value="">All payments</option>
          <option value="PAID">Paid</option>
          <option value="PARTIAL">Partially paid</option>
          <option value="UNPAID">Credit / Unpaid</option>
          <option value="REFUNDED">Refunded</option>
        </Select>
        <Select
          value={syncStatus}
          onChange={(e) => setSyncStatus(e.target.value as SyncStatusCode | '')}
          className="w-auto"
        >
          <option value="">All sync</option>
          <option value="SYNCED">Synced</option>
          <option value="PENDING">Pending</option>
          <option value="FAILED">Failed</option>
          <option value="NOT_SYNCED">Not synced</option>
        </Select>

        {/* Report export — covers every sale matching the current filters. */}
        <div className="ml-auto">
          <ExportMenu
            disabled={loading || total === 0}
            exporting={exporting}
            onExport={(format) => void handleExport(format)}
          />
        </div>
      </div>

      {error ? <p className="text-sm text-danger">{error}</p> : null}

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50 text-left text-muted-foreground">
                <th className="px-4 py-3 font-medium">Sale</th>
                <th className="px-4 py-3 font-medium">Date</th>
                <th className="px-4 py-3 font-medium">Customer</th>
                <th className="px-4 py-3 font-medium">Cashier</th>
                <th className="px-4 py-3 text-right font-medium">Items</th>
                <th className="px-4 py-3 text-right font-medium">Total</th>
                <th className="px-4 py-3 text-right font-medium">Balance</th>
                <th className="px-4 py-3 font-medium">Payment</th>
                <th className="px-4 py-3 font-medium">Sync</th>
                <th className="px-4 py-3 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={10} className="px-4 py-16 text-center text-muted-foreground">
                    Loading sales…
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={10} className="px-4 py-16 text-center">
                    <div className="flex flex-col items-center gap-3 text-muted-foreground">
                      <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-muted">
                        <ReceiptText className="h-6 w-6" />
                      </span>
                      <div>
                        <p className="font-medium text-foreground">No sales found</p>
                        <p className="text-sm">
                          Completed sales appear here as soon as a payment is taken.
                        </p>
                      </div>
                    </div>
                  </td>
                </tr>
              ) : (
                rows.map((s) => (
                  <tr key={s.id} className="border-b border-border last:border-0 hover:bg-muted/30">
                    <td className="px-4 py-3">
                      <Link
                        href={`/sales/${s.id}`}
                        className="font-medium text-primary hover:underline"
                      >
                        {s.saleNumber}
                      </Link>
                      {s.quickbooksDocumentType ? (
                        <div className="text-xs text-muted-foreground">
                          {s.quickbooksDocumentType === 'SALES_RECEIPT' ? 'Sales Receipt' : 'Invoice'}
                        </div>
                      ) : null}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">
                      {formatDateTime(s.completedAt ?? s.createdAt)}
                    </td>
                    <td className="px-4 py-3">{s.customerName ?? 'Walk-in customer'}</td>
                    <td className="px-4 py-3 text-muted-foreground">{s.cashierName ?? '—'}</td>
                    <td className="px-4 py-3 text-right text-muted-foreground">{s.itemCount}</td>
                    <td className="px-4 py-3 text-right font-medium">{formatMoney(s.total)}</td>
                    <td className="px-4 py-3 text-right">
                      {s.balanceAmount > 0 ? (
                        <span className="font-medium text-danger">
                          {formatMoney(s.balanceAmount)}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-col items-start gap-1">
                        <PaymentStatusBadge status={s.paymentStatus} />
                        <SaleReturnStatusBadge status={s.returnStatus} />
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <SyncBadge status={s.syncStatus} />
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1">
                        <Tooltip label="Reprint receipt">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                            aria-label="Reprint receipt"
                            disabled={busyId === s.id}
                            onClick={() => handleReprint(s.id)}
                          >
                            <Printer className="h-4 w-4" />
                          </Button>
                        </Tooltip>
                        {s.quickbooksDocumentType &&
                        (s.syncStatus === 'FAILED' || s.syncStatus === 'PENDING') ? (
                          <Tooltip label="Retry QuickBooks sync">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8"
                              aria-label="Retry QuickBooks sync"
                              disabled={busyId === s.id}
                              onClick={() => handleRetry(s.id)}
                            >
                              <RefreshCw
                                className={cn('h-4 w-4', busyId === s.id && 'animate-spin')}
                              />
                            </Button>
                          </Tooltip>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Pager chrome only when it can do something (same rules as the
          customers list): the footer needs more rows than the smallest page
          size — gating on the CURRENT size would make the selector vanish
          right after picking a larger one — and the buttons need a second
          page to go to. */}
      {total > Math.min(...PAGE_SIZES) ? (
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
          <div className="flex items-center gap-2 text-muted-foreground">
            <span>Rows per page</span>
            <Select
              value={String(pageSize)}
              onChange={(e) => setPageSize(Number(e.target.value))}
              className="w-auto"
            >
              {PAGE_SIZES.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-muted-foreground">
              {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, total)} of {total}
            </span>
            {totalPages > 1 ? (
              <div className="flex items-center gap-1">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page <= 1 || loading}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= totalPages || loading}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                >
                  Next
                </Button>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
