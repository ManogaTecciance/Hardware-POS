'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import * as React from 'react';
import { ArrowLeft, Pencil, RefreshCw } from 'lucide-react';

import { SyncBadge } from '@/components/quickbooks/sync-badge';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useAuth } from '@/lib/auth';
import {
  CUSTOMER_TYPE_LABELS,
  fetchCustomer,
  syncCustomerToQuickBooks,
  type ManagedCustomer,
} from '@/lib/customers-api';
import { Permission } from '@/lib/permissions';
import { formatMoney } from '@/lib/utils';

export default function CustomerDetailPage() {
  const { session, hasPermission } = useAuth();
  const canManage = hasPermission(Permission.CUSTOMER_MANAGE);
  const canSyncQb = hasPermission(Permission.QUICKBOOKS_MANAGE);
  const { id } = useParams<{ id: string }>();

  const [customer, setCustomer] = React.useState<ManagedCustomer | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [reloadKey, setReloadKey] = React.useState(0);

  React.useEffect(() => {
    if (!session || !id) return;
    let cancelled = false;
    setLoading(true);
    fetchCustomer(session, id)
      .then((c) => !cancelled && setCustomer(c))
      .catch((err: unknown) => !cancelled && setError(err instanceof Error ? err.message : 'Could not load customer'))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [session, id, reloadKey]);

  const handleSync = async () => {
    if (!session || !customer) return;
    setBusy(true);
    try {
      await syncCustomerToQuickBooks(session, customer.id);
      setReloadKey((k) => k + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sync failed');
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <p className="py-16 text-center text-sm text-muted-foreground">Loading…</p>;

  if (error || !customer) {
    return (
      <div className="space-y-4">
        <Link href="/customers" className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
          <ArrowLeft className="h-4 w-4" /> Back to customers
        </Link>
        <Card>
          <CardContent className="py-16 text-center text-sm text-danger">{error ?? 'Customer not found'}</CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <Link href="/customers" className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
            <ArrowLeft className="h-4 w-4" /> Back to customers
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight">{customer.name}</h1>
          <p className="text-sm text-muted-foreground">
            {CUSTOMER_TYPE_LABELS[customer.customerType]}
            {customer.company ? ` · ${customer.company}` : ''}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {canSyncQb && !customer.quickbooksCustomerId ? (
            <Button variant="outline" onClick={handleSync} disabled={busy}>
              <RefreshCw className="h-4 w-4" />
              Sync to QuickBooks
            </Button>
          ) : null}
          {canManage ? (
            <Link href={`/customers/${customer.id}/edit`} className={buttonVariants()}>
              <Pencil className="h-4 w-4" />
              Edit
            </Link>
          ) : null}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {customer.isActive ? <Badge variant="success">Active</Badge> : <Badge variant="danger">Inactive</Badge>}
        {customer.quickbooksCustomerId ? (
          <Badge variant="primary">QuickBooks-linked</Badge>
        ) : (
          <Badge variant="neutral">Not synced</Badge>
        )}
        <SyncBadge status={customer.quickbooksCustomerId ? 'SYNCED' : customer.syncStatus} />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Customer details</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
            <Detail label="Company" value={customer.company ?? '—'} />
            <Detail label="Customer type (QuickBooks)" value={customer.qbCustomerType ?? '—'} />
            <Detail label="Email" value={customer.email ?? '—'} />
            <Detail label="Phone" value={customer.phone ?? '—'} />
            <Detail label="Mobile" value={customer.mobile ?? '—'} />
            <Detail label="Fax" value={customer.fax ?? '—'} />
            <Detail label="Website" value={customer.website ?? '—'} />
            <Detail label="Resale number" value={customer.resaleNumber ?? '—'} />
            <Detail label="QuickBooks customer ID" value={customer.quickbooksCustomerId ?? 'Not synced'} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Payments &amp; credit</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-y-3 text-sm">
            <Detail label="POS customer type" value={CUSTOMER_TYPE_LABELS[customer.customerType]} />
            <Detail label="Credit" value={customer.creditAllowed ? 'Allowed' : 'Not allowed'} />
            <Detail
              label="Credit limit"
              value={
                customer.creditAllowed
                  ? customer.creditLimit != null
                    ? formatMoney(customer.creditLimit)
                    : 'No limit'
                  : '—'
              }
            />
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Address</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
            <Detail label="Street" value={customer.street ?? '—'} />
            <Detail label="City" value={customer.city ?? '—'} />
            <Detail label="State / Province" value={customer.state ?? '—'} />
            <Detail label="ZIP / Postal code" value={customer.zip ?? '—'} />
            <Detail label="Country" value={customer.country ?? '—'} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Opening balance</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div>
              <div className="text-xs text-muted-foreground">Amount (as entered)</div>
              <div className="text-lg font-semibold tabular-nums">
                {customer.openingBalance != null ? formatMoney(customer.openingBalance) : '—'}
              </div>
            </div>
            <Detail
              label="As of"
              value={
                customer.openingBalanceDate
                  ? new Date(customer.openingBalanceDate).toLocaleDateString('en-GB', {
                      year: 'numeric',
                      month: 'short',
                      day: 'numeric',
                    })
                  : '—'
              }
            />
            <p className="text-xs text-muted-foreground">
              The live receivable balance lives in QuickBooks (Sales → Customers).
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-0.5 font-medium">{value}</div>
    </div>
  );
}
