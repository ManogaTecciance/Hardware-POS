'use client';

import * as React from 'react';
import Link from 'next/link';
import { Plus, Search } from 'lucide-react';
import { QUOTATION_STATUS_LABELS, type QuotationStatusCode } from '@hardware-pos/shared';

import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { PAGE_SIZES, Pagination } from '@/components/ui/pagination';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { useAuth } from '@/lib/auth';
import { Permission } from '@/lib/permissions';
import { fetchQuotations, type QuotationListItem } from '@/lib/quotations';
import { formatMoney } from '@/lib/utils';

const STATUS_BADGE: Record<QuotationStatusCode, 'neutral' | 'primary' | 'success' | 'warning' | 'danger'> = {
  DRAFT: 'neutral',
  SENT: 'primary',
  ACCEPTED: 'success',
  REJECTED: 'danger',
  EXPIRED: 'warning',
  REVISED: 'primary',
  CONVERTED_TO_SALE: 'success',
  CANCELLED: 'neutral',
};

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

export default function QuotationsPage() {
  const { session, hasPermission } = useAuth();
  const [items, setItems] = React.useState<QuotationListItem[]>([]);
  const [total, setTotal] = React.useState(0);
  const [page, setPage] = React.useState(1);
  const [search, setSearch] = React.useState('');
  const [status, setStatus] = React.useState<QuotationStatusCode | ''>('');
  const [validity, setValidity] = React.useState<'' | 'valid' | 'expired'>('');
  const [loading, setLoading] = React.useState(true);
  // D139a — adjustable, like every other list. It was fixed at 25, which was
  // also the one page size in the product that no footer offered.
  const [pageSize, setPageSize] = React.useState(PAGE_SIZES[0]!);

  // Resizing re-numbers every page, so the reader starts from 1 — the same
  // rule the filters follow.
  React.useEffect(() => {
    setPage(1);
  }, [search, status, validity, pageSize]);

  React.useEffect(() => {
    if (!session) return;
    setLoading(true);
    const handle = window.setTimeout(() => {
      void fetchQuotations(session, {
        page,
        pageSize,
        search: search || undefined,
        status: status || undefined,
        validity: validity || undefined,
      })
        .then((r) => {
          setItems(r.items);
          setTotal(r.total);
        })
        .finally(() => setLoading(false));
    }, 250);
    return () => window.clearTimeout(handle);
  }, [session, page, pageSize, search, status, validity]);

  const canCreate = hasPermission(Permission.QUOTATION_CREATE);
  const pages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="space-y-5">
      <PageHeader
        title="Quotations"
        description="Create, search, revise, and convert customer quotations."
        actions={
          canCreate ? (
            <Link href="/quotations/new">
              <Button>
                <Plus className="h-4 w-4" /> New quotation
              </Button>
            </Link>
          ) : undefined
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by number, customer, phone, or company"
            className="pl-9"
          />
        </div>
        <Select value={status} onChange={(e) => setStatus(e.target.value as QuotationStatusCode | '')} className="max-w-[180px]">
          <option value="">All statuses</option>
          {(Object.keys(QUOTATION_STATUS_LABELS) as QuotationStatusCode[]).map((s) => (
            <option key={s} value={s}>
              {QUOTATION_STATUS_LABELS[s]}
            </option>
          ))}
        </Select>
        <Select value={validity} onChange={(e) => setValidity(e.target.value as '' | 'valid' | 'expired')} className="max-w-[150px]">
          <option value="">Any validity</option>
          <option value="valid">Valid</option>
          <option value="expired">Expired</option>
        </Select>
      </div>

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-muted/40 text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-4 py-3 font-medium">Number</th>
                <th className="px-4 py-3 font-medium">Date</th>
                <th className="px-4 py-3 font-medium">Customer</th>
                <th className="px-4 py-3 text-right font-medium">Items</th>
                <th className="px-4 py-3 text-right font-medium">Total</th>
                <th className="px-4 py-3 font-medium">Valid until</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Created by</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {items.map((q) => (
                <tr key={q.id} className="hover:bg-muted/30">
                  <td className="px-4 py-3">
                    <Link href={`/quotations/${q.id}`} className="font-medium text-primary hover:underline">
                      {q.revisionLabel}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{fmtDate(q.issueDate)}</td>
                  <td className="px-4 py-3">
                    <div>{q.customerName ?? 'Walk-in'}</div>
                    {q.customerPhone && (
                      <div className="text-xs text-muted-foreground">{q.customerPhone}</div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">{q.itemCount}</td>
                  <td className="px-4 py-3 text-right font-medium">{formatMoney(q.grandTotal)}</td>
                  <td className="px-4 py-3">
                    <span className={q.isExpired ? 'text-danger' : 'text-muted-foreground'}>
                      {fmtDate(q.validUntil)}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant={STATUS_BADGE[q.status]}>{QUOTATION_STATUS_LABELS[q.status]}</Badge>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{q.createdByName ?? '—'}</td>
                </tr>
              ))}
              {!loading && items.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-10 text-center text-muted-foreground">
                    No quotations found.
                  </td>
                </tr>
              )}
              {loading && (
                <tr>
                  <td colSpan={8} className="px-4 py-10 text-center text-muted-foreground">
                    Loading…
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <Pagination
        page={page}
        pageSize={pageSize}
        total={total}
        disabled={loading}
        onPageChange={setPage}
        onPageSizeChange={setPageSize}
      />
    </div>
  );
}
