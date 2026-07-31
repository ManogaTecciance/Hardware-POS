'use client';

import Link from 'next/link';
import * as React from 'react';
import { Ban, FileUp, FolderTree, PackagePlus, Pencil, Printer, RotateCcw, Search } from 'lucide-react';

import { ProductImage } from '@/components/product-image';
import { ImportProductsDialog } from '@/components/products/import-products-dialog';
import { ExportMenu } from '@/components/sales/export-menu';
import { PrintLabelsDialog } from '@/components/labels/print-labels-dialog';
import { PageHeader } from '@/components/page-header';
import { SyncBadge } from '@/components/quickbooks/sync-badge';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { SearchSelect } from '@/components/ui/search-select';
import { Select } from '@/components/ui/select';
import { Tooltip } from '@/components/ui/tooltip';
import { useAuth } from '@/lib/auth';
import { Permission } from '@/lib/permissions';
import {
  deactivateProduct,
  downloadProductsReport,
  fetchCategoryTree,
  fetchProducts,
  setProductActive,
  type CategoryNode,
  type ManagedProduct,
  type ProductsQuery,
  type ProductSyncStatus,
  type ReportFormat,
} from '@/lib/products-api';
import { cn, formatMoney } from '@/lib/utils';
import { resolveImageUrl } from '@/lib/products-api';

const PAGE_SIZES = [20, 30, 40, 50];

function isLowStock(p: ManagedProduct): boolean {
  return p.type === 'Inventory' && p.reorderLevel != null && p.quantityOnHand <= p.reorderLevel;
}

export default function ProductsPage() {
  const { session, hasPermission } = useAuth();
  const canManage = hasPermission(Permission.PRODUCT_MANAGE);

  const [search, setSearch] = React.useState('');
  const [debouncedSearch, setDebouncedSearch] = React.useState('');
  const [categoryId, setCategoryId] = React.useState('');
  const [subcategoryId, setSubcategoryId] = React.useState('');
  const [stockStatus, setStockStatus] = React.useState<'' | 'IN' | 'OUT' | 'LOW'>('');
  const [active, setActive] = React.useState<'' | 'true' | 'false'>('true');
  const [syncStatus, setSyncStatus] = React.useState<'' | ProductSyncStatus>('');
  const [exporting, setExporting] = React.useState<ReportFormat | null>(null);

  // Deep links (e.g. dashboard business alerts) pre-apply filters via the URL:
  // /products?stockStatus=OUT|LOW|IN&syncStatus=FAILED&type=…
  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const stock = params.get('stockStatus');
    if (stock === 'IN' || stock === 'OUT' || stock === 'LOW') setStockStatus(stock);
    const sync = params.get('syncStatus');
    if (sync && ['SYNCED', 'PENDING', 'NOT_SYNCED', 'FAILED', 'SYNCING'].includes(sync)) {
      setSyncStatus(sync as ProductSyncStatus);
    }
    const activeParam = params.get('isActive');
    if (activeParam === 'true' || activeParam === 'false' || activeParam === '') {
      setActive(activeParam as '' | 'true' | 'false');
    }
    const q = params.get('search');
    if (q) setSearch(q);
  }, []);
  const [page, setPage] = React.useState(1);
  const [pageSize, setPageSize] = React.useState(20);

  const [categories, setCategories] = React.useState<CategoryNode[]>([]);
  const [rows, setRows] = React.useState<ManagedProduct[]>([]);
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set());
  const [labelOpen, setLabelOpen] = React.useState(false);
  const [total, setTotal] = React.useState(0);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [reloadKey, setReloadKey] = React.useState(0);
  const [importOpen, setImportOpen] = React.useState(false);

  React.useEffect(() => {
    const t = window.setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => window.clearTimeout(t);
  }, [search]);

  React.useEffect(() => {
    setPage(1);
  }, [debouncedSearch, categoryId, subcategoryId, stockStatus, active, syncStatus, pageSize]);

  React.useEffect(() => {
    if (!session) return;
    fetchCategoryTree(session).then(setCategories).catch(() => setCategories([]));
  }, [session]);

  React.useEffect(() => {
    if (!session) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    const query: ProductsQuery = {
      page,
      pageSize,
      search: debouncedSearch || undefined,
      categoryId: categoryId || undefined,
      subcategoryId: subcategoryId || undefined,
      stockStatus: stockStatus || undefined,
      isActive: active || undefined,
      syncStatus: syncStatus || undefined,
    };
    fetchProducts(session, query)
      .then((res) => {
        if (cancelled) return;
        setRows(res.items);
        setTotal(res.total);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Could not load products');
        setRows([]);
        setTotal(0);
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [session, page, pageSize, debouncedSearch, categoryId, subcategoryId, stockStatus, active, syncStatus, reloadKey]);

  const toggleActive = async (p: ManagedProduct) => {
    if (!session) return;
    setBusyId(p.id);
    try {
      if (p.isActive) await deactivateProduct(session, p.id);
      else await setProductActive(session, p.id, true);
      setReloadKey((k) => k + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Update failed');
    } finally {
      setBusyId(null);
    }
  };

  const handleExport = async (format: ReportFormat) => {
    if (!session) return;
    setExporting(format);
    setError(null);
    try {
      await downloadProductsReport(
        session,
        {
          search: debouncedSearch || undefined,
          categoryId: categoryId || undefined,
          subcategoryId: subcategoryId || undefined,
          stockStatus: stockStatus || undefined,
          isActive: active || undefined,
          syncStatus: syncStatus || undefined,
        },
        format,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Export failed');
    } finally {
      setExporting(null);
    }
  };

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const subcategoryOptions = categoryId
    ? (categories.find((c) => c.id === categoryId)?.subcategories ?? [])
    : [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Products"
        description="Manage the product catalog. QuickBooks remains the inventory master."
        actions={
          <div className="flex items-center gap-2">
            <Link href="/products/categories" className={buttonVariants({ variant: 'outline' })}>
              <FolderTree className="h-4 w-4" />
              Categories
            </Link>
            {canManage ? (
              <>
                <Button variant="outline" onClick={() => setImportOpen(true)}>
                  <FileUp className="h-4 w-4" />
                  Import
                </Button>
                <Link href="/products/new" className={buttonVariants()}>
                  <PackagePlus className="h-4 w-4" />
                  Add product
                </Link>
              </>
            ) : null}
          </div>
        }
      />

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name or SKU…"
            className="pl-10"
          />
        </div>
        <SearchSelect
          ariaLabel="Filter by category"
          searchPlaceholder="Search categories…"
          value={categoryId}
          onChange={(id) => {
            setCategoryId(id);
            setSubcategoryId('');
          }}
          options={[
            { value: '', label: 'All categories' },
            ...categories.map((c) => ({
              value: c.id,
              label: c.name,
              hint: c.productCount > 0 ? String(c.productCount) : undefined,
            })),
          ]}
        />
        {subcategoryOptions.length > 0 ? (
          <Select
            value={subcategoryId}
            onChange={(e) => setSubcategoryId(e.target.value)}
            className="w-auto"
          >
            <option value="">All subcategories</option>
            {subcategoryOptions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        ) : null}
        <Select
          value={stockStatus}
          onChange={(e) => setStockStatus(e.target.value as '' | 'IN' | 'OUT' | 'LOW')}
          className="w-auto"
        >
          <option value="">All stock</option>
          <option value="IN">In stock</option>
          <option value="LOW">Low stock</option>
          <option value="OUT">Out of stock</option>
        </Select>
        <Select
          value={syncStatus}
          onChange={(e) => setSyncStatus(e.target.value as '' | ProductSyncStatus)}
          className="w-auto"
        >
          <option value="">All sync</option>
          <option value="SYNCED">Synced</option>
          <option value="PENDING">Pending</option>
          <option value="NOT_SYNCED">Not synced</option>
          <option value="FAILED">Failed</option>
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

        {/* Stock report export — covers every product matching the filters. */}
        <div className="ml-auto">
          <ExportMenu
            disabled={loading || total === 0}
            exporting={exporting}
            onExport={(format) => void handleExport(format)}
          />
        </div>
      </div>

      {error ? <p className="text-sm text-danger">{error}</p> : null}

      {selectedIds.size > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-primary/30 bg-brand-50 px-4 py-2.5 text-sm">
          <span className="font-medium">
            {selectedIds.size} product{selectedIds.size === 1 ? '' : 's'} selected
          </span>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setSelectedIds(new Set())}>
              Clear
            </Button>
            <Button size="sm" onClick={() => setLabelOpen(true)}>
              <Printer className="h-4 w-4" />
              Print labels
            </Button>
          </div>
        </div>
      ) : null}

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50 text-left text-muted-foreground">
                <th className="w-10 px-4 py-3">
                  <input
                    type="checkbox"
                    aria-label="Select all products on this page"
                    className="h-4 w-4 accent-[var(--color-primary)]"
                    checked={rows.length > 0 && rows.every((r) => selectedIds.has(r.id))}
                    onChange={(e) => {
                      const next = new Set(selectedIds);
                      for (const r of rows) {
                        if (e.target.checked) next.add(r.id);
                        else next.delete(r.id);
                      }
                      setSelectedIds(next);
                    }}
                  />
                </th>
                <th className="px-4 py-3 font-medium">Product</th>
                <th className="px-4 py-3 font-medium">SKU</th>
                <th className="px-4 py-3 text-right font-medium">Price</th>
                <th className="px-4 py-3 text-right font-medium">On hand</th>
                <th className="px-4 py-3 font-medium">Source</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={8} className="px-4 py-16 text-center text-muted-foreground">
                    Loading products…
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-16 text-center text-muted-foreground">
                    No products found.
                  </td>
                </tr>
              ) : (
                rows.map((p) => (
                  <tr key={p.id} className="border-b border-border last:border-0 hover:bg-muted/30">
                    <td className="px-4 py-3">
                      <input
                        type="checkbox"
                        aria-label={`Select ${p.name}`}
                        className="h-4 w-4 accent-[var(--color-primary)]"
                        checked={selectedIds.has(p.id)}
                        onChange={(e) => {
                          const next = new Set(selectedIds);
                          if (e.target.checked) next.add(p.id);
                          else next.delete(p.id);
                          setSelectedIds(next);
                        }}
                      />
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <ProductImage
                          src={resolveImageUrl(p.imageUrl)}
                          alt={p.name}
                          className="h-11 w-11 shrink-0"
                        />
                        <div className="min-w-0">
                          <Link
                            href={`/products/${p.id}`}
                            className="font-medium text-foreground hover:text-primary hover:underline"
                          >
                            {p.name}
                          </Link>
                          <div className="text-xs text-muted-foreground">
                            {p.type === 'NonInventory' ? 'Non-Inventory' : p.type}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{p.sku ?? '—'}</td>
                    <td className="px-4 py-3 text-right font-medium">{formatMoney(p.unitPrice)}</td>
                    <td className="px-4 py-3 text-right">
                      {p.type === 'Inventory' ? (
                        <>
                          <span className={cn(p.quantityOnHand <= 0 && 'font-medium text-danger')}>
                            {p.quantityOnHand}
                          </span>
                          {isLowStock(p) && p.quantityOnHand > 0 ? (
                            <div className="text-xs text-warning">Low</div>
                          ) : null}
                        </>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {p.quickbooksItemId ? (
                        <Badge variant="primary">QuickBooks</Badge>
                      ) : (
                        <Badge variant="neutral">Local</Badge>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-col items-start gap-1">
                        {!p.isActive ? <Badge variant="danger">Inactive</Badge> : null}
                        <SyncBadge status={p.syncStatus} />
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1">
                        {canManage ? (
                          <>
                            <Tooltip label="Edit product">
                              <Link
                                href={`/products/${p.id}/edit`}
                                className={buttonVariants({ variant: 'ghost', size: 'icon' })}
                                aria-label="Edit product"
                              >
                                <Pencil className="h-4 w-4" />
                              </Link>
                            </Tooltip>
                            <Tooltip label={p.isActive ? 'Deactivate product' : 'Reactivate product'}>
                              <Button
                                variant="ghost"
                                size="icon"
                                aria-label={p.isActive ? 'Deactivate' : 'Activate'}
                                disabled={busyId === p.id}
                                onClick={() => toggleActive(p)}
                                className={p.isActive ? 'text-danger' : 'text-success'}
                              >
                                {p.isActive ? (
                                  <Ban className="h-4 w-4" />
                                ) : (
                                  <RotateCcw className="h-4 w-4" />
                                )}
                              </Button>
                            </Tooltip>
                          </>
                        ) : (
                          <Link
                            href={`/products/${p.id}`}
                            className="text-sm text-primary hover:underline"
                          >
                            View
                          </Link>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Pagination */}
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
        <PrintLabelsDialog
          session={session}
          open={labelOpen}
          onClose={() => setLabelOpen(false)}
          targets={rows
            .filter((r) => selectedIds.has(r.id))
            .map((r) => ({ id: r.id, name: r.name, sku: r.sku, price: r.unitPrice }))}
        />
      ) : null}

      {session ? (
        <ImportProductsDialog
          session={session}
          open={importOpen}
          onClose={() => setImportOpen(false)}
          onImported={() => setReloadKey((k) => k + 1)}
        />
      ) : null}
    </div>
  );
}
