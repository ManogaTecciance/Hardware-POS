'use client';

import Link from 'next/link';
import * as React from 'react';
import { FileUp, Plus, Truck } from 'lucide-react';

import { PageHeader } from '@/components/page-header';
import { ImportSuppliersDialog } from '@/components/suppliers/import-suppliers-dialog';
import { SupplierSearchFilters } from '@/components/suppliers/supplier-search-filters';
import {
  SupplierEmptyState,
  SupplierErrorState,
  SupplierTableSkeleton,
} from '@/components/suppliers/supplier-states';
import { SupplierTable } from '@/components/suppliers/supplier-table';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Pagination } from '@/components/ui/pagination';
import { useAuth } from '@/lib/auth';
import { deriveSupplierAccess } from '@/lib/suppliers/access';
import { fetchSuppliers } from '@/lib/suppliers/suppliers-api';
import type { Supplier, SuppliersQuery } from '@/lib/suppliers/types';

const PAGE_SIZE = 20;

export default function SuppliersPage() {
  const { session } = useAuth();
  const access = deriveSupplierAccess(session?.user.permissions ?? []);

  const [search, setSearch] = React.useState('');
  const [debouncedSearch, setDebouncedSearch] = React.useState('');
  const [filters, setFilters] = React.useState<SuppliersQuery>({ sort: 'name' });
  const [page, setPage] = React.useState(1);

  const [rows, setRows] = React.useState<Supplier[]>([]);
  const [total, setTotal] = React.useState(0);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [importOpen, setImportOpen] = React.useState(false);
  const [reloadKey, setReloadKey] = React.useState(0);

  const reload = React.useCallback(() => setReloadKey((k) => k + 1), []);

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
        setError(err instanceof Error ? err.message : 'Could not load vendors.');
        setRows([]);
        setTotal(0);
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [session, access.canView, query, reloadKey]);

  const filterCount = (filters.isActive !== undefined ? 1 : 0) + (filters.qbStatus ? 1 : 0);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

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
        description="Vendors mirrored on the QuickBooks vendor record — import them in bulk or add them one at a time."
        actions={
          access.canManage ? (
            <div className="flex items-center gap-2">
              <Button variant="outline" onClick={() => setImportOpen(true)}>
                <FileUp className="h-4 w-4" />
                Import
              </Button>
              <Link href="/suppliers/new" className={buttonVariants()}>
                <Plus className="h-4 w-4" />
                Add vendor
              </Link>
            </div>
          ) : undefined
        }
      />

      <SupplierSearchFilters
        search={search}
        onSearchChange={setSearch}
        query={filters}
        onChange={(patch) => setFilters((f) => ({ ...f, ...patch }))}
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
            title={
              filterCount > 0 || debouncedSearch
                ? 'No vendors match your filters'
                : 'No vendors have been added yet'
            }
            description={
              filterCount > 0 || debouncedSearch
                ? 'Try adjusting your search or clearing filters.'
                : 'Add your first vendor, or import them in bulk from the QuickBooks vendor template.'
            }
            action={
              access.canManage && filterCount === 0 && !debouncedSearch ? (
                <div className="flex items-center gap-2">
                  <Button variant="outline" onClick={() => setImportOpen(true)}>
                    <FileUp className="h-4 w-4" />
                    Import vendors
                  </Button>
                  <Link href="/suppliers/new" className={buttonVariants()}>
                    <Plus className="h-4 w-4" />
                    Add vendor
                  </Link>
                </div>
              ) : undefined
            }
          />
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <SupplierTable rows={rows} />
          </div>
        </Card>
      )}

      {!error && !showEmpty ? (
        <Pagination
          page={page}
          pageSize={PAGE_SIZE}
          total={total}
          disabled={loading}
          onPageChange={setPage}
        />
      ) : null}

      {session ? (
        <ImportSuppliersDialog
          session={session}
          open={importOpen}
          onClose={() => setImportOpen(false)}
          onImported={reload}
        />
      ) : null}
    </div>
  );
}
