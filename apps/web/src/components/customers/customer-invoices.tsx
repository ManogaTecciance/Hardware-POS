'use client';

import Link from 'next/link';
import * as React from 'react';
import { Check, Undo2 } from 'lucide-react';

import { saleStatusLabel } from '@hardware-pos/shared';

import { SyncBadge } from '@/components/quickbooks/sync-badge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import type { Session } from '@/lib/auth';
import {
  fetchSales,
  setSaleMarkedPaid,
  type PaymentStatusCode,
  type SaleListItem,
} from '@/lib/sales';
import { cn, formatMoney } from '@/lib/utils';

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
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [reloadKey, setReloadKey] = React.useState(0);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchSales(session, { customerId, page: 1, pageSize: 100 })
      .then((res) => !cancelled && setRows(res.items))
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load invoices');
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [session, customerId, reloadKey]);

  // The rule the API enforces, mirrored so the button can explain itself before
  // it is pressed rather than only after.
  const unmarkedCredit = rows.filter((s) => isOwed(s) && s.markedPaidAt === null);
  const isLastUnmarked = (s: SaleListItem) =>
    unmarkedCredit.length === 1 && unmarkedCredit[0]?.id === s.id;

  const toggle = async (s: SaleListItem) => {
    setBusyId(s.id);
    setError(null);
    try {
      await setSaleMarkedPaid(session, s.id, s.markedPaidAt === null);
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
      <CardHeader>
        <CardTitle>Invoices</CardTitle>
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
                  No invoices for this customer yet.
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
                        {!owed && !s.markedPaidAt ? (
                          // Nothing to account for — it was paid at the till or
                          // covered when the account cleared.
                          <span className="text-xs text-muted-foreground">—</span>
                        ) : (
                          <Button
                            variant={s.markedPaidAt ? 'ghost' : 'outline'}
                            size="sm"
                            disabled={busyId === s.id || blocked}
                            title={
                              blocked
                                ? `The last invoice on the account: record payments covering the ${formatMoney(
                                    outstanding,
                                  )} still outstanding, which settles it without marking.`
                                : undefined
                            }
                            onClick={() => void toggle(s)}
                          >
                            {s.markedPaidAt ? (
                              <>
                                <Undo2 className="h-4 w-4" />
                                Undo
                              </>
                            ) : (
                              <>
                                <Check className="h-4 w-4" />
                                Mark paid
                              </>
                            )}
                          </Button>
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
      {!loading && unmarkedCredit.length === 1 && outstanding > 0 ? (
        <p className="border-t border-border bg-muted/30 px-4 py-3 text-xs text-muted-foreground">
          One invoice is left to account for. It can only be ticked off once the{' '}
          {formatMoney(outstanding)} outstanding is covered by recorded payments — which settles it
          anyway, so the books can never read clear without the money.
        </p>
      ) : null}
    </Card>
  );
}
