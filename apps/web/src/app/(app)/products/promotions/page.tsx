'use client';

import { Ban, Loader2, Pencil, Plus, RotateCcw, Search, Sparkles, Trash2 } from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';

import { PageHeader } from '@/components/page-header';
import { InventoryTabs } from '@/components/products/inventory-tabs';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Tooltip } from '@/components/ui/tooltip';
import { useAuth } from '@/lib/auth';
import { Permission } from '@/lib/permissions';
import {
  activatePromotion,
  deactivatePromotion,
  deletePromotion,
  fetchPromotions,
  labelForPromotionType,
  summarisePromotionSchedule,
  type Promotion,
} from '@/lib/products/promotions-api';

/**
 * Promotions admin — list (D45).
 *
 * Read/manage the tenant's promotions. Filters:
 *   • Search (client-side over the loaded page — the server also accepts
 *     branch/channel/product filters when the volume grows).
 *   • Active/Inactive/All toggle.
 *
 * Row actions: Edit (link), Activate/Deactivate (in place), Delete
 * (confirmation Dialog). Header action: `+ New promotion`.
 */
export default function PromotionsPage() {
  const { session, hasPermission } = useAuth();
  const canManage = hasPermission(Permission.PRODUCT_MANAGE);

  const [rows, setRows] = React.useState<Promotion[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [search, setSearch] = React.useState('');
  const [activeFilter, setActiveFilter] = React.useState<'all' | 'active' | 'inactive'>('all');
  const [reloadKey, setReloadKey] = React.useState(0);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = React.useState<Promotion | null>(null);

  React.useEffect(() => {
    if (!session) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    const query =
      activeFilter === 'active'
        ? { isActive: true }
        : activeFilter === 'inactive'
          ? { isActive: false }
          : {};
    fetchPromotions(session, query)
      .then((res) => {
        if (!cancelled) setRows(res.items);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load promotions');
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [session, activeFilter, reloadKey]);

  const filtered = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        (p.description ?? '').toLowerCase().includes(q) ||
        labelForPromotionType(p.type).toLowerCase().includes(q),
    );
  }, [rows, search]);

  const toggleActive = async (p: Promotion) => {
    if (!session) return;
    setBusyId(p.id);
    try {
      if (p.isActive) await deactivatePromotion(session, p.id);
      else await activatePromotion(session, p.id);
      setReloadKey((k) => k + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update promotion');
    } finally {
      setBusyId(null);
    }
  };

  const confirmDelete = async () => {
    if (!session || !deleteTarget) return;
    setBusyId(deleteTarget.id);
    try {
      await deletePromotion(session, deleteTarget.id);
      setDeleteTarget(null);
      setReloadKey((k) => k + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete promotion');
    } finally {
      setBusyId(null);
    }
  };

  if (!session) return null;

  return (
    <div className="space-y-6">
      <InventoryTabs />
      <PageHeader
        title="Promotions"
        description="Bundles, BOGO offers and percentage or amount discounts."
        actions={
          canManage ? (
            <Link href="/products/promotions/new" className={buttonVariants()}>
              <Plus className="h-4 w-4" />
              New promotion
            </Link>
          ) : null
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search promotions…"
            className="pl-10"
          />
        </div>
        <Select
          value={activeFilter}
          onChange={(e) => setActiveFilter(e.target.value as 'all' | 'active' | 'inactive')}
          className="w-auto"
          aria-label="Filter by active state"
        >
          <option value="all">All</option>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
        </Select>
      </div>

      {error ? (
        <p className="rounded-lg border border-danger/40 bg-danger-soft p-3 text-sm text-danger" role="alert">
          {error}
        </p>
      ) : null}

      {loading ? (
        <Card>
          <CardContent className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin motion-reduce:hidden" aria-hidden="true" />
            Loading promotions…
          </CardContent>
        </Card>
      ) : filtered.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center gap-3 py-16 text-center">
            <Sparkles className="h-8 w-8 text-primary" aria-hidden="true" />
            <p className="text-sm font-medium">
              {search
                ? 'No promotions match your search.'
                : rows.length === 0
                  ? 'No promotions yet.'
                  : 'No promotions match the filters.'}
            </p>
            <p className="max-w-md text-xs text-muted-foreground">
              Create bundles, BOGO offers or discounts to run alongside your regular menu.
            </p>
            {canManage ? (
              <Link href="/products/promotions/new" className={buttonVariants()}>
                <Plus className="h-4 w-4" />
                Create promotion
              </Link>
            ) : null}
          </CardContent>
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/50 text-left text-muted-foreground">
                  <th className="px-4 py-3 font-medium">Name</th>
                  <th className="px-4 py-3 font-medium">Type</th>
                  <th className="px-4 py-3 font-medium">Schedule</th>
                  <th className="px-4 py-3 text-right font-medium">Products</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((p) => (
                  <tr key={p.id} className="border-b border-border last:border-0 hover:bg-muted/30">
                    <td className="px-4 py-3">
                      <div className="min-w-0">
                        <Link
                          href={`/products/promotions/${p.id}/edit`}
                          className="font-medium text-foreground hover:text-primary hover:underline"
                        >
                          {p.name}
                        </Link>
                        {p.description ? (
                          <div className="truncate text-xs text-muted-foreground">
                            {p.description}
                          </div>
                        ) : null}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant="neutral">{labelForPromotionType(p.type)}</Badge>
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      {summarisePromotionSchedule(p)}
                    </td>
                    <td className="px-4 py-3 text-right text-muted-foreground">
                      {p.items.length}
                    </td>
                    <td className="px-4 py-3">
                      {p.isActive ? (
                        <Badge variant="success">Active</Badge>
                      ) : (
                        <Badge variant="danger">Inactive</Badge>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1">
                        {canManage ? (
                          <>
                            <Tooltip label="Edit promotion">
                              <Link
                                href={`/products/promotions/${p.id}/edit`}
                                className={buttonVariants({ variant: 'ghost', size: 'icon' })}
                                aria-label="Edit promotion"
                              >
                                <Pencil className="h-4 w-4" />
                              </Link>
                            </Tooltip>
                            <Tooltip
                              label={p.isActive ? 'Deactivate promotion' : 'Reactivate promotion'}
                            >
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
                            <Tooltip label="Delete promotion">
                              <Button
                                variant="ghost"
                                size="icon"
                                aria-label="Delete promotion"
                                disabled={busyId === p.id}
                                onClick={() => setDeleteTarget(p)}
                                className="text-danger"
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </Tooltip>
                          </>
                        ) : (
                          <Link
                            href={`/products/promotions/${p.id}/edit`}
                            className="text-sm text-primary hover:underline"
                          >
                            View
                          </Link>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <Dialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title="Delete promotion?"
        description={
          deleteTarget
            ? `${deleteTarget.name} will be permanently deleted. This cannot be undone.`
            : undefined
        }
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleteTarget(null)} disabled={!!busyId}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => void confirmDelete()} disabled={!!busyId}>
              {busyId ? 'Deleting…' : 'Delete'}
            </Button>
          </>
        }
      >
        <p className="text-sm text-muted-foreground">
          Consider deactivating instead — a deactivated promotion can be reactivated later without
          reconfiguring items or schedule.
        </p>
      </Dialog>
    </div>
  );
}
