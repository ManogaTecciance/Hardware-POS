'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import * as React from 'react';
import { FileUp, Info, Search, UserPlus, X } from 'lucide-react';

import { ImportCustomersDialog } from '@/components/customers/import-customers-dialog';
import { PageHeader } from '@/components/page-header';
import { SyncBadge } from '@/components/quickbooks/sync-badge';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Pagination } from '@/components/ui/pagination';
import { Tooltip } from '@/components/ui/tooltip';
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
import { isModuleEnabled } from '@/lib/platform-api';
import { useEffectiveProfile } from '@/lib/platform-profile';
import { formatMoney } from '@/lib/utils';


/**
 * How much of the limit this customer has already used, and what that leaves.
 *
 * Spelled out rather than shown as three columns: the breakdown is what you want
 * at the moment you are deciding on one customer, not while scanning the table.
 */
function creditBreakdown(c: ManagedCustomer): string {
  const used = c.outstandingCredit ?? 0;
  const limit = c.creditLimit;
  if (limit == null) return `${formatMoney(used)} used · no limit set`;
  return `${formatMoney(used)} of ${formatMoney(limit)} used · ${formatMoney(
    Math.max(0, limit - used),
  )} left`;
}
const TYPE_OPTIONS = Object.keys(CUSTOMER_TYPE_LABELS) as CustomerType[];

export default function CustomersPage() {
  const { session, hasPermission } = useAuth();
  const canManage = hasPermission(Permission.CUSTOMER_MANAGE);
  const searchParams = useSearchParams();
  const router = useRouter();

  // Seeded from the URL so the dashboard's receivable card can deep-link
  // straight to the customers who owe it. Only the initial value comes from the
  // URL — after that the filter is the user's to clear.
  const [owingOnly, setOwingOnly] = React.useState(
    () => searchParams.get('hasOutstandingCredit') === 'true',
  );
  const { profile } = useEffectiveProfile();
  // Unresolved profile = no QuickBooks affordances, never the legacy default.
  const quickbooksEnabled = profile ? isModuleEnabled(profile, 'QUICKBOOKS') : false;
  // The empty-state cells span the header row: five fixed columns plus Sync when
  // QuickBooks is on. One named place to update when a column is added above.
  const columnCount = quickbooksEnabled ? 6 : 5;

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
    // Collapse internal whitespace runs, not just the ends: the API matches
    // with a literal `contains`, so "x  x" would otherwise miss "x x".
    const t = window.setTimeout(() => setDebouncedSearch(search.replace(/\s+/g, ' ').trim()), 300);
    return () => window.clearTimeout(t);
  }, [search]);

  React.useEffect(() => {
    setPage(1);
  }, [debouncedSearch, customerType, active, owingOnly, pageSize]);

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
      hasOutstandingCredit: owingOnly ? 'true' : undefined,
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
  }, [session, page, pageSize, debouncedSearch, customerType, active, owingOnly, reloadKey]);

  /**
   * Open a customer from anywhere in their row.
   *
   * The row is a mouse convenience over the name link, which stays as the
   * keyboard and screen-reader path — making the row itself focusable would add
   * a second tab stop to the same destination and announce the whole row as a
   * link.
   *
   * Three clicks are deliberately not a same-tab navigation: one that lands on
   * something interactive (the name link, the Edit link, the credit info icon),
   * which owns its own behaviour; one that ends a text selection, because
   * reading a phone number off the table is a copy and not a click; and a
   * right-click, which belongs to the context menu. A middle- or modifier-click
   * still opens the customer, in the new tab the user asked for.
   */
  const handleOpen = (event: React.MouseEvent<HTMLTableRowElement>, id: string) => {
    // Right-click belongs to the context menu; onAuxClick fires for it too.
    if (event.button === 2) return;
    if (
      (event.target as HTMLElement).closest('a, button, input, select, textarea, [role="button"]')
    ) {
      return;
    }
    if (window.getSelection()?.toString().trim()) return;
    const href = `/customers/${id}`;
    if (event.button === 1 || event.metaKey || event.ctrlKey || event.shiftKey) {
      window.open(href, '_blank', 'noopener');
      return;
    }
    router.push(href);
  };

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Customers"
        description={
          quickbooksEnabled
            ? 'Manage customers. New customers sync to QuickBooks on their first sale.'
            : 'Manage customers.'
        }
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
        <Button
          variant={owingOnly ? 'primary' : 'outline'}
          onClick={() => setOwingOnly((v) => !v)}
          aria-pressed={owingOnly}
        >
          Credit outstanding
          {owingOnly ? <X className="h-4 w-4" aria-label="Clear filter" /> : null}
        </Button>
      </div>

      {error ? <p className="text-sm text-danger">{error}</p> : null}

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50 text-left text-muted-foreground">
                <th className="px-4 py-3 font-medium">Customer</th>
                <th className="px-4 py-3 font-medium">Phone</th>
                <th className="px-4 py-3 font-medium">Credit limit</th>
                <th className="px-4 py-3 font-medium">Available credit</th>
                {quickbooksEnabled ? <th className="px-4 py-3 font-medium">Sync</th> : null}
                <th className="px-4 py-3 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={columnCount} className="px-4 py-16 text-center text-muted-foreground">
                    Loading customers…
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={columnCount} className="px-4 py-16 text-center text-muted-foreground">
                    No customers found.
                  </td>
                </tr>
              ) : (
                rows.map((c) => (
                  <tr
                    key={c.id}
                    onClick={(e) => handleOpen(e, c.id)}
                    onAuxClick={(e) => handleOpen(e, c.id)}
                    className="cursor-pointer border-b border-border transition-colors last:border-0 hover:bg-muted/30"
                  >
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
                    {/* POS-created customers carry their number in `mobile` (capture popup
    posts `mobile`), so read it the way the rest of the app does. */}
                    <td className="px-4 py-3 text-muted-foreground">{c.mobile ?? c.phone ?? '—'}</td>
                    <td className="px-4 py-3">
                      {/* Only a figure earns a place here. A customer with no limit
                          configured has no number to show, so the cell stays empty
                          rather than carrying wording the column cannot explain —
                          the detail page states it in full, next to whether credit
                          is allowed at all. */}
                      <span className="text-muted-foreground">
                        {c.creditAllowed && c.creditLimit != null ? formatMoney(c.creditLimit) : '—'}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      {c.availableCredit != null ? (
                        <span className="inline-flex items-center gap-1.5">
                          <span
                            className={
                              c.availableCredit < 0 ? 'text-danger' : 'text-muted-foreground'
                            }
                          >
                            {formatMoney(c.availableCredit)}
                          </span>
                          {/* The figure alone does not say what it was counted down
                              from, and that is the question anyone about to approve
                              a sale actually has. */}
                          <Tooltip label={creditBreakdown(c)}>
                            <span
                              tabIndex={0}
                              role="button"
                              aria-label={`Credit breakdown: ${creditBreakdown(c)}`}
                              className="cursor-help rounded text-muted-foreground/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            >
                              <Info className="h-3.5 w-3.5" />
                            </span>
                          </Tooltip>
                        </span>
                      ) : (
                        // No limit set means there is nothing to count down from —
                        // showing zero here would read as "no credit left".
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    {quickbooksEnabled ? (
                      <td className="px-4 py-3">
                        {c.quickbooksCustomerId ? (
                          <SyncBadge status="SYNCED" />
                        ) : (
                          <SyncBadge status={c.syncStatus} />
                        )}
                      </td>
                    ) : null}
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

      <Pagination
        page={page}
        pageSize={pageSize}
        total={total}
        disabled={loading}
        onPageChange={setPage}
        onPageSizeChange={setPageSize}
      />

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
