'use client';

import Link from 'next/link';
import * as React from 'react';
import { FileUp, Search, UserPlus } from 'lucide-react';

import { ImportCustomersDialog } from '@/components/customers/import-customers-dialog';
import { PageHeader } from '@/components/page-header';
import { SyncBadge } from '@/components/quickbooks/sync-badge';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { useAuth } from '@/lib/auth';
import {
  CUSTOMER_TYPE_LABELS,
  fetchCustomers,
  type CustomersQuery,
  type CustomerType,
  type ManagedCustomer,
} from '@/lib/customers-api';
import { Permission } from '@/lib/permissions';
import { formatMoney } from '@/lib/utils';

const PAGE_SIZES = [20, 30, 40, 50];
const TYPE_OPTIONS = Object.keys(CUSTOMER_TYPE_LABELS) as CustomerType[];

export default function CustomersPage() {
  const { session, hasPermission } = useAuth();
  const canManage = hasPermission(Permission.CUSTOMER_MANAGE);

  const [search, setSearch] = React.useState('');
  const [debouncedSearch, setDebouncedSearch] = React.useState('');
  const [customerType, setCustomerType] = React.useState<'' | CustomerType>('');
  const [active, setActive] = React.useState<'' | 'true' | 'false'>('true');
  const [page, setPage] = React.useState(1);
  const [pageSize, setPageSize] = React.useState(20);

  const [rows, setRows] = React.useState<ManagedCustomer[]>([]);
  const [total, setTotal] = React.useState(0);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [importOpen, setImportOpen] = React.useState(false);
  const [reloadKey, setReloadKey] = React.useState(0);

  React.useEffect(() => {
    const t = window.setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => window.clearTimeout(t);
  }, [search]);

  React.useEffect(() => {
    setPage(1);
  }, [debouncedSearch, customerType, active, pageSize]);

  React.useEffect(() => {
    if (!session) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    const query: CustomersQuery = {
      page,
      pageSize,
      search: debouncedSearch || undefined,
      customerType: customerType || undefined,
      isActive: active || undefined,
    };
    fetchCustomers(session, query)
      .then((res) => {
        if (cancelled) return;
        setRows(res.items);
        setTotal(res.total);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Could not load customers');
        setRows([]);
        setTotal(0);
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [session, page, pageSize, debouncedSearch, customerType, active, reloadKey]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Customers"
        description="Manage customers. New customers sync to QuickBooks on their first sale."
        actions={
          canManage ? (
            <div className="flex items-center gap-2">
              <Button variant="outline" onClick={() => setImportOpen(true)}>
                <FileUp className="h-4 w-4" />
                Import
              </Button>
              <Link href="/customers/new" className={buttonVariants()}>
                <UserPlus className="h-4 w-4" />
                Add customer
              </Link>
            </div>
          ) : undefined
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, company, phone, or email…"
            className="pl-10"
          />
        </div>
        <Select
          value={customerType}
          onChange={(e) => setCustomerType(e.target.value as '' | CustomerType)}
          className="w-auto"
        >
          <option value="">All types</option>
          {TYPE_OPTIONS.map((t) => (
            <option key={t} value={t}>
              {CUSTOMER_TYPE_LABELS[t]}
            </option>
          ))}
        </Select>
        <Select
          value={active}
          onChange={(e) => setActive(e.target.value as '' | 'true' | 'false')}
          className="w-auto"
        >
          <option value="true">Active</option>
          <option value="false">Inactive</option>
          <option value="">All</option>
        </Select>
      </div>

      {error ? <p className="text-sm text-danger">{error}</p> : null}

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50 text-left text-muted-foreground">
                <th className="px-4 py-3 font-medium">Customer</th>
                <th className="px-4 py-3 font-medium">Type</th>
                <th className="px-4 py-3 font-medium">Phone</th>
                <th className="px-4 py-3 font-medium">Credit</th>
                <th className="px-4 py-3 font-medium">Sync</th>
                <th className="px-4 py-3 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={6} className="px-4 py-16 text-center text-muted-foreground">
                    Loading customers…
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-16 text-center text-muted-foreground">
                    No customers found.
                  </td>
                </tr>
              ) : (
                rows.map((c) => (
                  <tr key={c.id} className="border-b border-border last:border-0 hover:bg-muted/30">
                    <td className="px-4 py-3">
                      <Link
                        href={`/customers/${c.id}`}
                        className="font-medium text-foreground hover:text-primary hover:underline"
                      >
                        {c.name}
                      </Link>
                      {c.company ? (
                        <div className="text-xs text-muted-foreground">{c.company}</div>
                      ) : null}
                      {!c.isActive ? (
                        <Badge variant="danger" className="mt-1">
                          Inactive
                        </Badge>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {CUSTOMER_TYPE_LABELS[c.customerType]}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{c.phone ?? '—'}</td>
                    <td className="px-4 py-3">
                      {c.creditAllowed ? (
                        <span className="text-muted-foreground">
                          {c.creditLimit != null ? formatMoney(c.creditLimit) : 'No limit'}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {c.quickbooksCustomerId ? (
                        <SyncBadge status="SYNCED" />
                      ) : (
                        <SyncBadge status={c.syncStatus} />
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {canManage ? (
                        <Link
                          href={`/customers/${c.id}/edit`}
                          className="text-sm text-primary hover:underline"
                        >
                          Edit
                        </Link>
                      ) : (
                        <Link
                          href={`/customers/${c.id}`}
                          className="text-sm text-primary hover:underline"
                        >
                          View
                        </Link>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>

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
            {total === 0 ? '0' : `${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, total)}`} of{' '}
            {total}
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
      </div>

      {session ? (
        <ImportCustomersDialog
          session={session}
          open={importOpen}
          onClose={() => setImportOpen(false)}
          onImported={() => setReloadKey((k) => k + 1)}
        />
      ) : null}
    </div>
  );
}
