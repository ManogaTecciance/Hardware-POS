'use client';

import * as React from 'react';
import { Search } from 'lucide-react';

import { paymentMethodLabel } from '@hardware-pos/shared';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { PAGE_SIZES, Pagination } from '@/components/ui/pagination';
import type { AccountPayment } from '@/lib/customers-api';
import { formatMoney } from '@/lib/utils';

/** Date and time both: two payments on one day are told apart only by the time. */
function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-LK', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Money received against this customer's credit account, newest first.
 *
 * Searched and paged in the browser rather than on the server: the endpoint
 * returns a customer's payments as one list, and a customer has as many of these
 * as they have made payments — a bounded number that is already in hand. Going
 * back to the API per keystroke would buy nothing.
 */
export function CustomerCreditHistory({
  payments,
  outstanding,
}: {
  payments: AccountPayment[];
  /** What the account still owes, for the empty state's wording. */
  outstanding: number;
}) {
  const [search, setSearch] = React.useState('');
  const [page, setPage] = React.useState(1);
  const [pageSize, setPageSize] = React.useState(PAGE_SIZES[0] as number);

  React.useEffect(() => setPage(1), [search, pageSize]);

  const filtered = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return payments;
    // Everything the row shows is searchable, so what you can read you can find.
    return payments.filter((p) =>
      [
        paymentMethodLabel(p.method),
        p.reference ?? '',
        formatDateTime(p.createdAt),
        String(p.amount),
        formatMoney(p.amount),
      ]
        .join(' ')
        .toLowerCase()
        .includes(q),
    );
  }, [payments, search]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const shown = filtered.slice((page - 1) * pageSize, page * pageSize);

  return (
    <Card className="overflow-hidden">
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-3 space-y-0">
        <CardTitle>Credit history</CardTitle>
        {/* Wide enough for the placeholder to read in full: the search icon
            takes 36px of the field before any text starts. */}
        <div className="relative w-full min-w-[240px] max-w-[300px]">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search method, reference…"
            className="h-9 pl-9"
          />
        </div>
      </CardHeader>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/50 text-left text-muted-foreground">
              <th className="px-4 py-3 font-medium">Date &amp; time</th>
              <th className="px-4 py-3 font-medium">Method</th>
              <th className="px-4 py-3 font-medium">Reference</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 text-right font-medium">Amount</th>
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-10 text-center text-muted-foreground">
                  {search.trim()
                    ? 'No payments match that search.'
                    : outstanding > 0
                      ? `Nothing received yet against ${formatMoney(outstanding)} outstanding.`
                      : 'No account payments recorded.'}
                </td>
              </tr>
            ) : (
              shown.map((p) => (
                <tr key={p.id} className="border-b border-border last:border-0">
                  <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">
                    {formatDateTime(p.createdAt)}
                  </td>
                  <td className="px-4 py-3">{paymentMethodLabel(p.method)}</td>
                  <td className="px-4 py-3 text-muted-foreground">{p.reference ?? '—'}</td>
                  <td className="px-4 py-3">
                    {/* "Cleared" is the payment that closed a balance, together
                        with everything that had been building toward it. */}
                    <Badge variant={p.settledAt ? 'success' : 'warning'}>
                      {p.settledAt ? 'Cleared the balance' : 'Against open balance'}
                    </Badge>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-right font-medium">
                    {formatMoney(p.amount)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <Pagination
        className="border-t border-border px-4 py-3"
        page={page}
        pageSize={pageSize}
        total={filtered.length}
        onPageChange={setPage}
        onPageSizeChange={setPageSize}
      />
    </Card>
  );
}
