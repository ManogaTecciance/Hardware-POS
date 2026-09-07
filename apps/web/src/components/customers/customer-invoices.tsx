'use client';

import Link from 'next/link';
import * as React from 'react';
import { Check, Search } from 'lucide-react';

import { saleStatusLabel } from '@hardware-pos/shared';

import { SyncBadge } from '@/components/quickbooks/sync-badge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Tooltip } from '@/components/ui/tooltip';
import type { Session } from '@/lib/auth';
import {
  fetchSales,
  setSaleMarkedPaid,
  type PaymentStatusCode,
  type SaleListItem,
} from '@/lib/sales';
import { cn, formatMoney } from '@/lib/utils';

const PAGE_SIZE = 10;

const STATUS_VARIANT: Record<PaymentStatusCode, 'success' | 'neutral' | 'danger'> = {
  PAID: 'success',
  PARTIAL: 'danger',
  UNPAID: 'danger',
  REFUNDED: 'neutral',
};

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-LK', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatDay(iso: string): string {
  return new Date(iso).toLocaleDateString('en-LK', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
  });
}

/** Still owed for: on credit, and the account has not cleared it. */
function isOwed(s: SaleListItem): boolean {
  return s.balanceAmount > 0 && s.creditSettledAt === null;
}

/**
 * This customer's invoices, with a tick to account for each credit one.
 *
 * The tick is bookkeeping — it records who accounted for an invoice and when,
 * and moves no money. The customer still owes what the account says they owe.
 * That is why the last uncovered invoice cannot be ticked while the account is
 * short: ticking everything is what would make the account read as dealt with,
 * so that final one is left to the payments, which settle it on their own.
 */
export function CustomerInvoices({
  session,
  customerId,
  outstanding,
  canMark,
  onChanged,
}: {
  session: Session;
  customerId: string;
  /** The account balance, for the last-invoice rule. */
  outstanding: number;
  canMark: boolean;
  onChanged: () => void;
}) {
  const [rows, setRows] = React.useState<SaleListItem[]>([]);
  const [total, setTotal] = React.useState(0);
  const [page, setPage] = React.useState(1);
  const [search, setSearch] = React.useState('');
  const [debouncedSearch, setDebouncedSearch] = React.useState('');
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [reloadKey, setReloadKey] = React.useState(0);
  // How many invoices are still to be accounted for across the WHOLE account,
  // not just this page — the last-invoice rule is about the account, and paging
  // away from a row must not change what the button says.
  const [unmarkedTotal, setUnmarkedTotal] = React.useState(0);

  React.useEffect(() => {
    const t = window.setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => window.clearTimeout(t);
  }, [search]);

  React.useEffect(() => setPage(1), [debouncedSearch]);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchSales(session, {
      customerId,
      page,
      pageSize: PAGE_SIZE,
      search: debouncedSearch || undefined,
    })
      .then((res) => {
        if (cancelled) return;
        setRows(res.items);
        setTotal(res.total);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load invoices');
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [session, customerId, page, debouncedSearch, reloadKey]);

  // Counted unfiltered and unpaged, so a search or a page change cannot make an
  // invoice look like the last one when it is not.
  React.useEffect(() => {
    let cancelled = false;
    fetchSales(session, { customerId, page: 1, pageSize: 200, paymentStatus: 'UNPAID' })
      .then((res) => {
        if (cancelled) return;
        setUnmarkedTotal(res.items.filter((s) => isOwed(s) && s.markedPaidAt === null).length);
      })
      .catch(() => !cancelled && setUnmarkedTotal(0));
    return () => {
      cancelled = true;
    };
  }, [session, customerId, reloadKey]);

  // The rule the API enforces, mirrored so the button can explain itself before
  // it is pressed rather than only after.
  const isLastUnmarked = (s: SaleListItem) =>
    unmarkedTotal === 1 && isOwed(s) && s.markedPaidAt === null;

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const markPaid = async (s: SaleListItem) => {
    setBusyId(s.id);
    setError(null);
    try {
      await setSaleMarkedPaid(session, s.id, true);
      setReloadKey((k) => k + 1);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update the invoice');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Card className="overflow-hidden">
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-3 space-y-0">
        <CardTitle>Invoices</CardTitle>
        {/* Wide enough for the placeholder to read in full: the search icon
            takes 36px of the field before any text starts. */}
        <div className="relative w-full min-w-[240px] max-w-[300px]">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search invoice no…"
            className="h-9 pl-9"
          />
        </div>
      </CardHeader>
      {error ? <p className="px-6 pb-3 text-sm text-danger">{error}</p> : null}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/50 text-left text-muted-foreground">
              <th className="px-4 py-3 font-medium">Sale</th>
              <th className="px-4 py-3 font-medium">Date</th>
              <th className="px-4 py-3 text-right font-medium">Total</th>
              <th className="px-4 py-3 font-medium">Due</th>
              <th className="px-4 py-3 font-medium">Payment</th>
              <th className="px-4 py-3 font-medium">Accounted for</th>
              <th className="px-4 py-3 font-medium">Sync</th>
              {canMark ? <th className="px-4 py-3 text-right font-medium">Actions</th> : null}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={8} className="px-4 py-12 text-center text-muted-foreground">
                  Loading invoices…
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-12 text-center text-muted-foreground">
                  {debouncedSearch ? 'No invoices match that search.' : 'No invoices for this customer yet.'}
                </td>
              </tr>
            ) : (
              rows.map((s) => {
                const owed = isOwed(s);
                const blocked = owed && s.markedPaidAt === null && isLastUnmarked(s) && outstanding > 0;
                return (
                  <tr key={s.id} className="border-b border-border last:border-0">
                    <td className="px-4 py-3">
                      <Link
                        href={`/sales/${s.id}`}
                        className="font-medium text-primary hover:underline"
                      >
                        {s.saleNumber}
                      </Link>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">
                      {formatDay(s.completedAt ?? s.createdAt)}
                    </td>
                    <td
                      className={cn(
                        'whitespace-nowrap px-4 py-3 text-right font-medium',
                        owed && 'text-danger',
                      )}
                    >
                      {formatMoney(s.total)}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">
                      {s.paymentDueDate ? formatDay(s.paymentDueDate) : '—'}
                    </td>
                    <td className="px-4 py-3">
                      <Badge
                        variant={s.creditSettledAt ? 'success' : STATUS_VARIANT[s.paymentStatus]}
                      >
                        {saleStatusLabel(s.paymentStatus, s.creditSettledAt)}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {s.markedPaidAt ? (
                        <span className="text-xs">
                          {formatDateTime(s.markedPaidAt)}
                          {s.markedPaidByName ? ` · ${s.markedPaidByName}` : ''}
                        </span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <SyncBadge status={s.syncStatus} />
                    </td>
                    {canMark ? (
                      <td className="px-4 py-3 text-right">
                        {!owed || s.markedPaidAt ? (
                          // Nothing to account for — it was paid at the till or
                          // covered when the account cleared.
                          <span className="text-xs text-muted-foreground">—</span>
                        ) : (
                          // A disabled button swallows the native `title`, so the
                          // reason rides on a wrapper that still receives hover.
                          <Tooltip
                            label={
                              blocked
                                ? `Last invoice on the account — record payments covering the ${formatMoney(
                                    outstanding,
                                  )} still outstanding, which settles it without marking`
                                : 'Account this invoice as paid'
                            }
                          >
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={busyId === s.id || blocked}
                              onClick={() => void markPaid(s)}
                            >
                              <Check className="h-4 w-4" />
                              Mark paid
                            </Button>
                          </Tooltip>
                        )}
                      </td>
                    ) : null}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      {totalPages > 1 ? (
        <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-3 text-sm">
          <span className="text-muted-foreground">
            {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, total)} of {total}
          </span>
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
        </div>
      ) : null}

    </Card>
  );
}
