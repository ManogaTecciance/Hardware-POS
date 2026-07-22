'use client';

import Link from 'next/link';
import * as React from 'react';
import { Plus, Truck } from 'lucide-react';

import { PageHeader } from '@/components/page-header';
import { SupplierCard } from '@/components/suppliers/supplier-card';
import { SupplierSearchFilters } from '@/components/suppliers/supplier-search-filters';
import {
  DemoDataBanner,
  SupplierEmptyState,
  SupplierErrorState,
  SupplierTableSkeleton,
} from '@/components/suppliers/supplier-states';
import { SupplierSummaryGrid } from '@/components/suppliers/supplier-summary-grid';
import { SupplierTable } from '@/components/suppliers/supplier-table';
import { useSupplierActionDialogs } from '@/components/suppliers/use-supplier-action-dialogs';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { useAuth } from '@/lib/auth';
import { deriveSupplierAccess } from '@/lib/suppliers/access';
import { isDemoData } from '@/lib/suppliers/suppliers-api';
import {
  fetchSuppliers,
  fetchSupplierSummary,
  fetchSupplierCategories,
} from '@/lib/suppliers/suppliers-api';
import { activeFilterCount } from '@/lib/suppliers/view-models';
import type {
  SupplierCategoryRef,
  SupplierListItem,
  SupplierSummaryMetrics,
  SuppliersQuery,
} from '@/lib/suppliers/types';

const PAGE_SIZE = 20;

type SummaryKey = 'active' | 'outstanding' | 'pending' | 'attention';

const SUMMARY_FILTER: Record<SummaryKey, Partial<SuppliersQuery>> = {
  active: { status: 'ACTIVE' },
  outstanding: { hasOutstanding: true },
  pending: { pendingActivity: true },
  attention: { attention: true },
};

export default function SuppliersPage() {
  const { session } = useAuth();
  const access = deriveSupplierAccess(session?.user.permissions ?? []);

  const [search, setSearch] = React.useState('');
  const [debouncedSearch, setDebouncedSearch] = React.useState('');
  const [filters, setFilters] = React.useState<SuppliersQuery>({ sort: 'name' });
  const [page, setPage] = React.useState(1);

  const [rows, setRows] = React.useState<SupplierListItem[]>([]);
  const [total, setTotal] = React.useState(0);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const [metrics, setMetrics] = React.useState<SupplierSummaryMetrics | null>(null);
  const [metricsLoading, setMetricsLoading] = React.useState(true);
  const [categories, setCategories] = React.useState<SupplierCategoryRef[]>([]);
  const [reloadKey, setReloadKey] = React.useState(0);

  const reload = React.useCallback(() => setReloadKey((k) => k + 1), []);

  const { request, dialogs } = useSupplierActionDialogs(session, {
    onChanged: reload,
    onDeleted: reload,
  });

  // Debounce search.
  React.useEffect(() => {
    const t = window.setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => window.clearTimeout(t);
  }, [search]);

  React.useEffect(() => setPage(1), [debouncedSearch, filters]);

  const query = React.useMemo<SuppliersQuery>(
    () => ({ ...filters, search: debouncedSearch || undefined, page, pageSize: PAGE_SIZE }),
    [filters, debouncedSearch, page],
  );

  // Summary + categories (once per session / reload).
  React.useEffect(() => {
    if (!session || !access.canView) return;
    let cancelled = false;
    setMetricsLoading(true);
    fetchSupplierSummary(session)
      .then((m) => !cancelled && setMetrics(m))
      .catch(() => !cancelled && setMetrics(null))
      .finally(() => !cancelled && setMetricsLoading(false));
    fetchSupplierCategories(session)
      .then((c) => !cancelled && setCategories(c))
      .catch(() => !cancelled && setCategories([]));
    return () => {
      cancelled = true;
    };
  }, [session, access.canView, reloadKey]);

  // List.
  React.useEffect(() => {
    if (!session || !access.canView) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchSuppliers(session, query)
      .then((res) => {
        if (cancelled) return;
        setRows(res.items);
        setTotal(res.total);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Could not load suppliers.');
        setRows([]);
        setTotal(0);
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [session, access.canView, query, reloadKey]);

  const filterCount = activeFilterCount(filters);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const activeSummaryKey = (Object.keys(SUMMARY_FILTER) as SummaryKey[]).find((key) => {
    const patch = SUMMARY_FILTER[key];
    return Object.entries(patch).every(([k, v]) => filters[k as keyof SuppliersQuery] === v);
  });

  const onSelectSummary = (key: SummaryKey) => {
    setFilters((f) => {
      const patch = SUMMARY_FILTER[key];
      const alreadyOn = Object.entries(patch).every(([k, v]) => f[k as keyof SuppliersQuery] === v);
      if (alreadyOn) {
        const next = { ...f };
        for (const k of Object.keys(patch)) delete next[k as keyof SuppliersQuery];
        return next;
      }
      return { ...f, ...patch };
    });
  };

  if (session && !access.canView) {
    return (
      <Card>
        <SupplierEmptyState
          icon={Truck}
          title="You don’t have access to suppliers"
          description="Supplier management is available to owners, purchasing staff, and accountants. Ask an administrator if you need access."
        />
      </Card>
    );
  }

  const showEmpty = !loading && !error && rows.length === 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Suppliers"
        description="Manage supplier contacts, product relationships, balances, and purchasing activity."
        actions={
          access.canManage ? (
            <Link href="/suppliers/new" className={buttonVariants()}>
              <Plus className="h-4 w-4" />
              Add supplier
            </Link>
          ) : undefined
        }
      />

      {isDemoData() ? <DemoDataBanner /> : null}

      <SupplierSummaryGrid
        metrics={metrics}
        loading={metricsLoading}
        activeKey={activeSummaryKey ?? null}
        onSelect={onSelectSummary}
      />

      <SupplierSearchFilters
        search={search}
        onSearchChange={setSearch}
        query={filters}
        onChange={(patch) => setFilters((f) => ({ ...f, ...patch }))}
        categories={categories}
        activeCount={filterCount}
        onClear={() => {
          setFilters({ sort: filters.sort });
          setSearch('');
        }}
      />

      {error ? (
        <Card>
          <SupplierErrorState message={error} onRetry={reload} />
        </Card>
      ) : loading ? (
        <Card className="overflow-hidden">
          <SupplierTableSkeleton />
        </Card>
      ) : showEmpty ? (
        <Card>
          <SupplierEmptyState
            icon={Truck}
            title={filterCount > 0 || debouncedSearch ? 'No suppliers match your filters' : 'No suppliers have been added yet'}
            description={
              filterCount > 0 || debouncedSearch
                ? 'Try adjusting your search or clearing filters.'
                : 'Add your first supplier to start tracking contacts, products, and purchasing activity.'
            }
            action={
              access.canManage && filterCount === 0 && !debouncedSearch ? (
                <Link href="/suppliers/new" className={buttonVariants()}>
                  <Plus className="h-4 w-4" />
                  Add supplier
                </Link>
              ) : undefined
            }
          />
        </Card>
      ) : (
        <>
          {/* Desktop / laptop: data table. */}
          <Card className="hidden overflow-hidden lg:block">
            <div className="overflow-x-auto">
              <SupplierTable rows={rows} access={access} request={request} />
            </div>
          </Card>

          {/* Portrait tablet / mobile: cards. */}
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:hidden">
            {rows.map((item) => (
              <SupplierCard key={item.id} item={item} access={access} request={request} />
            ))}
          </div>
        </>
      )}

      {!error && !showEmpty ? (
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
          <span className="text-muted-foreground">
            {total === 0 ? '0' : `${(page - 1) * PAGE_SIZE + 1}–${Math.min(page * PAGE_SIZE, total)}`} of {total}
          </span>
          <div className="flex items-center gap-1">
            <Button variant="outline" size="sm" disabled={page <= 1 || loading} onClick={() => setPage((p) => Math.max(1, p - 1))}>
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

      {dialogs}
    </div>
  );
}
