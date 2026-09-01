'use client';

import Link from 'next/link';
import { ArrowLeft, PackagePlus, Pencil, RefreshCw, Trash2 } from 'lucide-react';
import * as React from 'react';

import { ProductImage } from '@/components/product-image';
import { ProductStatusBadge } from '@/components/products/product-status-badge';
import { ReceiveStockDialog } from '@/components/products/receive-stock-dialog';
import { VariantEditDialog } from '@/components/products/variant-edit-dialog';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Menu, type MenuItem } from '@/components/ui/menu';
import { Select } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Toast } from '@/components/ui/toast';
import { type Session } from '@/lib/auth';
import { Permission } from '@/lib/permissions';
import { resolveProductManagementPresentation } from '@/lib/products/product-presentation';
import type { BranchSummary } from '@/lib/products/branches-api';
import { useIsTabletUp } from '@/lib/use-viewport';
import {
  fetchReceipts,
  type InventoryReceipt,
  type ReceiptQuery,
} from '@/lib/products/receipts-api';
import {
  deleteVariant,
  fetchVariantInventory,
  fetchVariants,
  updateVariant,
  type ProductVariant,
  type ProductVariationDimension,
  type VariantBranchInventory,
} from '@/lib/products/variants-api';
import type { CategoryNode, ManagedProduct } from '@/lib/products-api';
import { fetchSuppliers } from '@/lib/suppliers/suppliers-api';
import type { Supplier } from '@/lib/suppliers/types';
import { cn, formatMoney } from '@/lib/utils';
import { resolveImageUrl } from '@/lib/products-api';

/**
 * Product Details tabbed page (D44).
 *
 * The old single-flat page couldn't grow: variants, per-branch inventory,
 * purchases and history each earn their own view once the catalogue can hold
 * matrix products. Tabs keep the URL stable while letting each panel own its
 * lazy data fetch — Inventory and Purchases don't call the API at all until
 * the operator visits them.
 *
 * Header actions are gated by two concerns kept independent: PRODUCT_MANAGE
 * decides whether Edit is offered at all, and the presentation resolver
 * decides whether Receive Stock even applies to this tenant's inventory mode
 * (a QuickBooks-mastered tenant does not receive stock through this UI).
 * The server is still the authority — hiding is a usability concern only.
 */

interface Props {
  session: Session;
  product: ManagedProduct;
  variants: ProductVariant[];
  variations: ProductVariationDimension[];
  branches: BranchSummary[];
  presentation: ReturnType<typeof resolveProductManagementPresentation>;
  hasReceivePermission: boolean;
  hasManagePermission: boolean;
  /**
   * QuickBooks sync affordance — kept as a prop rather than looked up inside
   * this component so `product-detail.tsx` stays free of any QuickBooks
   * network coupling and can be rendered in isolation from a test harness.
   * When `false` the Sync button never renders regardless of presentation.
   */
  canSyncQb: boolean;
  syncBusy: boolean;
  onSync: () => void;
  onReload: () => void;
}

type TabKey = 'overview' | 'variants' | 'inventory' | 'purchases' | 'history';

/** "200ml · Glass Bottle" — the read-only summary shown next to every variant. */
function variantLabel(v: ProductVariant): string {
  const parts = v.optionValues.map((o) => o.optionName).filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : v.sku;
}

export function ProductDetail({
  session,
  product,
  variants: initialVariants,
  variations,
  branches,
  presentation,
  hasReceivePermission,
  hasManagePermission,
  canSyncQb,
  syncBusy,
  onSync,
  onReload,
}: Props) {
  const [variants, setVariants] = React.useState<ProductVariant[]>(initialVariants);
  const [tab, setTab] = React.useState<TabKey>('overview');
  const [toast, setToast] = React.useState<string | null>(null);

  // ── Receive Stock dialog ─────────────────────────────────────────────────
  const [receiveOpen, setReceiveOpen] = React.useState(false);
  // Suppliers are needed by the Receive Stock dialog only, so their fetch is
  // deferred until the operator actually opens it. That saves a network call
  // on every page load for a catalogue-only tenant who never touches it.
  const [suppliers, setSuppliers] = React.useState<Supplier[]>([]);
  const [suppliersLoaded, setSuppliersLoaded] = React.useState(false);
  React.useEffect(() => {
    if (!receiveOpen || suppliersLoaded) return;
    fetchSuppliers(session, { pageSize: 200, isActive: 'true' })
      .then((res) => setSuppliers(res.items))
      .catch(() => setSuppliers([]))
      .finally(() => setSuppliersLoaded(true));
  }, [receiveOpen, suppliersLoaded, session]);

  // ── Variant edit + delete ────────────────────────────────────────────────
  const [editingVariant, setEditingVariant] = React.useState<ProductVariant | null>(null);
  const [deletingVariant, setDeletingVariant] = React.useState<ProductVariant | null>(null);
  const [deleteError, setDeleteError] = React.useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = React.useState(false);

  const refreshVariants = React.useCallback(async () => {
    try {
      const next = await fetchVariants(session, product.id);
      setVariants(next);
    } catch {
      // Fail quietly — the local list is still usable; a hard reload lands
      // on the next tab click.
    }
  }, [session, product.id]);

  const setVariantActive = async (v: ProductVariant, active: boolean) => {
    try {
      const updated = await updateVariant(session, product.id, v.id, { isActive: active });
      setVariants((prev) => prev.map((x) => (x.id === updated.id ? updated : x)));
      setToast(active ? 'Variant activated.' : 'Variant deactivated.');
    } catch (err) {
      setToast(err instanceof Error ? err.message : 'Could not update variant');
    }
  };

  const confirmDeleteVariant = async () => {
    if (!deletingVariant) return;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await deleteVariant(session, product.id, deletingVariant.id);
      setVariants((prev) => prev.filter((v) => v.id !== deletingVariant.id));
      setDeletingVariant(null);
      setToast('Variant deleted.');
    } catch (err) {
      // Historical references are the common blocker — the message is
      // deliberately actionable (set inactive) rather than a bare 409.
      const raw = err instanceof Error ? err.message : String(err);
      if (/VARIANT_HAS_HISTORY/i.test(raw)) {
        setDeleteError(
          'This variant has historical sales, returns, receipts, or menu links and cannot be permanently deleted. Set it inactive instead.',
        );
      } else {
        setDeleteError(raw || 'Delete failed');
      }
    } finally {
      setDeleteBusy(false);
    }
  };

  // ── Derived counts + KPIs ────────────────────────────────────────────────
  const activeVariantCount = variants.filter((v) => v.isActive).length;
  const hasVariants = product.hasVariants && variants.length > 0;

  // Latest cost across variants is the max (recency proxied by averageCost
  // freshness); for single-variant products it's the parent's costPrice.
  const latestCost = hasVariants
    ? variants.reduce<number | null>(
        (max, v) => (v.costPrice != null && (max == null || v.costPrice > max) ? v.costPrice : max),
        null,
      )
    : product.costPrice;

  const canReceive = hasReceivePermission && presentation.managementMode === 'LOCAL';

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/products"
          className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
        >
          <ArrowLeft className="h-4 w-4" /> Back to products
        </Link>
      </div>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-4">
          <ProductImage
            src={resolveImageUrl(product.imageUrl) ?? undefined}
            alt={product.name}
            className="h-16 w-16 shrink-0"
          />
          <div className="space-y-1.5">
            <h1 className="text-2xl font-semibold tracking-tight">{product.name}</h1>
            <div className="flex flex-wrap items-center gap-2">
              {product.isActive ? (
                <Badge variant="success">Active</Badge>
              ) : (
                <Badge variant="danger">Inactive</Badge>
              )}
              {hasVariants ? (
                <Badge variant="primary">{activeVariantCount} Active Variants</Badge>
              ) : null}
              {presentation.sourceDetailLabel ? (
                <Badge variant={presentation.sourceBadgeKind}>
                  {presentation.sourceDetailLabel}
                </Badge>
              ) : null}
              <ProductStatusBadge presentation={presentation} syncStatus={product.syncStatus} />
              {product.sku ? (
                <span className="text-xs text-muted-foreground">SKU: {product.sku}</span>
              ) : null}
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* Sync to QuickBooks — preserved from the pre-D44 detail page so a
              QuickBooks-managed tenant still has the manual push affordance
              their historical scripts and manuals point at (CLAUDE.md
              "preserve QuickBooks behaviour"). Gated on the resolver, not on
              inventoryMode directly (D31). */}
          {presentation.showSyncActions && canSyncQb && !product.quickbooksItemId ? (
            <Button
              variant="outline"
              leftIcon={<RefreshCw className="h-4 w-4" />}
              onClick={onSync}
              disabled={syncBusy}
            >
              Sync to QuickBooks
            </Button>
          ) : null}
          {hasManagePermission ? (
            <Link
              href={`/products/${product.id}/edit`}
              className={buttonVariants({ variant: 'outline' })}
            >
              <Pencil className="h-4 w-4" />
              Edit
            </Link>
          ) : null}
          {canReceive ? (
            <Button leftIcon={<PackagePlus className="h-4 w-4" />} onClick={() => setReceiveOpen(true)}>
              Receive Stock
            </Button>
          ) : null}
        </div>
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as TabKey)}>
        <TabsList aria-label="Product sections">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          {hasVariants ? <TabsTrigger value="variants">Variants</TabsTrigger> : null}
          <TabsTrigger value="inventory">Inventory</TabsTrigger>
          <TabsTrigger value="purchases">Purchases</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-6">
          <OverviewTab
            product={product}
            variants={variants}
            latestCost={latestCost}
            hasVariants={hasVariants}
          />
        </TabsContent>

        {hasVariants ? (
          <TabsContent value="variants" className="mt-6">
            <VariantsTab
              variants={variants}
              hasManagePermission={hasManagePermission}
              onEdit={setEditingVariant}
              onToggleActive={setVariantActive}
              onDelete={setDeletingVariant}
            />
          </TabsContent>
        ) : null}

        <TabsContent value="inventory" className="mt-6">
          <InventoryTab
            session={session}
            product={product}
            variants={variants}
            branches={branches}
            hasVariants={hasVariants}
            isActive={tab === 'inventory'}
          />
        </TabsContent>

        <TabsContent value="purchases" className="mt-6">
          <PurchasesTab
            session={session}
            productId={product.id}
            variants={variants}
            suppliers={suppliers}
            suppliersLoaded={suppliersLoaded}
            onNeedSuppliers={() => setSuppliersLoaded((v) => v)}
            isActive={tab === 'purchases'}
          />
        </TabsContent>

        <TabsContent value="history" className="mt-6">
          <Card>
            <CardContent className="py-12 text-center text-sm text-muted-foreground">
              Stock movement history coming soon. Stock receipts are recorded on the
              Purchases tab; sales / returns updates propagate through their own audit trails.
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <ReceiveStockDialog
        open={receiveOpen}
        onClose={() => setReceiveOpen(false)}
        session={session}
        product={product}
        variants={variants}
        branches={branches}
        suppliers={suppliers}
        onSuccess={(receipt) => {
          const line = receipt.lines[0];
          const label = line?.productVariantId
            ? variants.find((v) => v.id === line.productVariantId)
            : null;
          setToast(
            `Stock received: ${line?.quantityReceived ?? 0} of ${product.name}${
              label ? ' — ' + variantLabel(label) : ''
            }`,
          );
          // Weighted-average moves after any receipt — pull the parent + variants
          // fresh so KPIs and averageCost match the server's new truth.
          onReload();
          void refreshVariants();
        }}
      />

      <VariantEditDialog
        open={editingVariant !== null}
        onClose={() => setEditingVariant(null)}
        session={session}
        productId={product.id}
        variant={editingVariant}
        variations={variations}
        onSaved={(updated) => {
          setVariants((prev) => prev.map((v) => (v.id === updated.id ? updated : v)));
          setToast('Variant saved.');
        }}
      />

      <Dialog
        open={deletingVariant !== null}
        onClose={() => (deleteBusy ? undefined : (setDeletingVariant(null), setDeleteError(null)))}
        title="Delete variant permanently?"
        description={
          deletingVariant
            ? `“${variantLabel(deletingVariant)}” will be removed from this product. Only variants with no history can be permanently deleted.`
            : undefined
        }
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => {
                setDeletingVariant(null);
                setDeleteError(null);
              }}
              disabled={deleteBusy}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => void confirmDeleteVariant()}
              disabled={deleteBusy}
              leftIcon={<Trash2 className="h-4 w-4" />}
            >
              {deleteBusy ? 'Deleting...' : 'Delete permanently'}
            </Button>
          </>
        }
      >
        {deleteError ? (
          <p className="text-sm text-danger" role="alert">
            {deleteError}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">This action cannot be undone.</p>
        )}
      </Dialog>

      {toast ? <Toast message={toast} tone="success" /> : null}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Overview tab
// ─────────────────────────────────────────────────────────────────────────────

function OverviewTab({
  product,
  variants,
  latestCost,
  hasVariants,
}: {
  product: ManagedProduct;
  variants: ProductVariant[];
  latestCost: number | null;
  hasVariants: boolean;
}) {
  // Low-stock warning aggregates across variants (matrix) or falls back to the
  // parent's own on-hand for single-variant / legacy products. The threshold is
  // per-variant to respect the operator's per-SKU reorder points, and any hit
  // surfaces the same banner rather than a per-row indicator that would clutter
  // Overview — the Variants tab is where the row-level view lives.
  const lowStockVariants = hasVariants
    ? variants.filter(
        (v) => v.reorderLevel != null && v.reorderLevel > 0 /* wait for real per-branch data on Inventory tab */,
      )
    : [];
  const singleLowStock =
    !hasVariants &&
    product.reorderLevel != null &&
    product.quantityOnHand <= product.reorderLevel;

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Product</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <ProductImage
            src={resolveImageUrl(product.imageUrl) ?? undefined}
            alt={product.name}
            className="aspect-square w-full"
          />
          <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-2">
            <Fact label="Type" value={product.type === 'NonInventory' ? 'Non-Inventory' : product.type} />
            <Fact label="SKU" value={product.sku ?? '—'} />
            <Fact label="Status" value={product.isActive ? 'Active' : 'Inactive'} />
            <Fact
              label="Track inventory"
              value={product.type === 'Inventory' ? 'Yes' : 'No'}
            />
            {product.description ? (
              <div className="sm:col-span-2">
                <dt className="text-xs text-muted-foreground">Description</dt>
                <dd className="mt-0.5 text-sm">{product.description}</dd>
              </div>
            ) : null}
          </dl>
        </CardContent>
      </Card>

      <div className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>At a glance</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid gap-3 sm:grid-cols-2">
              <Kpi
                label="Variants"
                value={hasVariants ? `${variants.filter((v) => v.isActive).length} active` : 'Single-variant product'}
              />
              <Kpi
                label="Total stock"
                value={
                  hasVariants
                    ? '—'
                    : product.type === 'Inventory'
                      ? String(product.quantityOnHand)
                      : 'Not tracked'
                }
                hint={hasVariants ? 'See Inventory tab for per-branch totals' : undefined}
              />
              <Kpi label="Latest cost" value={latestCost != null ? formatMoney(latestCost) : '—'} />
              <Kpi
                label="Average cost"
                value={product.averageCost != null ? formatMoney(product.averageCost) : '—'}
              />
              <Kpi label="Selling price" value={formatMoney(product.unitPrice)} />
              <Kpi
                label="Reorder point"
                value={product.reorderLevel != null ? String(product.reorderLevel) : '—'}
              />
            </div>
          </CardContent>
        </Card>

        {singleLowStock || lowStockVariants.length > 0 ? (
          <div className="rounded-2xl border border-warning-soft bg-warning-soft/40 p-4 text-sm text-warning">
            {singleLowStock
              ? 'This product is at or below its reorder point.'
              : `${lowStockVariants.length} variant${lowStockVariants.length === 1 ? '' : 's'} may need restocking. See the Variants tab for details.`}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 font-medium">{value}</dd>
    </div>
  );
}

function Kpi({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-border bg-surface p-3">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 text-lg font-semibold">{value}</p>
      {hint ? <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Variants tab
// ─────────────────────────────────────────────────────────────────────────────

function VariantsTab({
  variants,
  hasManagePermission,
  onEdit,
  onToggleActive,
  onDelete,
}: {
  variants: ProductVariant[];
  hasManagePermission: boolean;
  onEdit: (v: ProductVariant) => void;
  onToggleActive: (v: ProductVariant, active: boolean) => void;
  onDelete: (v: ProductVariant) => void;
}) {
  // Nine columns fits on desktop but crams on iPad landscape (1024) and is
  // unusable on portrait. `useIsTabletUp` picks between the truthfully
  // scannable table (≥900) and a stacked-card list (<900). SSR default is
  // `true`, so first paint is desktop-correct.
  const isTabletUp = useIsTabletUp();

  // Menu contents don't depend on viewport, only on the row — extracted so
  // the table row and the card share exactly one action set. A drift here
  // would mean the tablet operator sees a different action list than the
  // desktop one — that class of bug is precisely what this factory rules out.
  const buildMenuItems = (v: ProductVariant): MenuItem[] => [
    { label: 'Edit', onSelect: () => onEdit(v) },
    v.isActive
      ? { label: 'Set inactive', onSelect: () => onToggleActive(v, false) }
      : { label: 'Set active', onSelect: () => onToggleActive(v, true) },
    {
      label: 'Delete permanently',
      danger: true,
      separatorBefore: true,
      onSelect: () => onDelete(v),
    },
  ];

  if (variants.length === 0) {
    // Same empty-state look in both modes — the card viewport never sees a
    // colSpan, and repeating an ad-hoc empty state at each fork would drift.
    return (
      <Card>
        <CardContent className="py-12 text-center text-sm text-muted-foreground">
          No variants yet.
        </CardContent>
      </Card>
    );
  }

  if (!isTabletUp) {
    return (
      <div className="space-y-3" role="list">
        {variants.map((v) => (
          <VariantCard
            key={v.id}
            variant={v}
            hasManagePermission={hasManagePermission}
            menuItems={buildMenuItems(v)}
          />
        ))}
      </div>
    );
  }

  return (
    <Card className="overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/50 text-left text-muted-foreground">
              <th className="px-4 py-3 font-medium">Variant</th>
              <th className="px-4 py-3 font-medium">SKU</th>
              <th className="px-4 py-3 font-medium">Barcode</th>
              <th className="px-4 py-3 text-right font-medium">Selling price</th>
              <th className="px-4 py-3 text-right font-medium">Latest cost</th>
              <th className="px-4 py-3 text-right font-medium">Average cost</th>
              <th className="px-4 py-3 text-right font-medium">Reorder</th>
              <th className="px-4 py-3 font-medium">Status</th>
              {hasManagePermission ? <th className="px-4 py-3 text-right font-medium">Actions</th> : null}
            </tr>
          </thead>
          <tbody>
            {variants.map((v) => (
              <tr key={v.id} className="border-b border-border last:border-0 hover:bg-muted/30">
                <td className="px-4 py-3 font-medium">{variantLabel(v)}</td>
                <td className="px-4 py-3 text-muted-foreground">{v.sku}</td>
                <td className="px-4 py-3 text-muted-foreground">{v.barcode ?? '—'}</td>
                <td className="px-4 py-3 text-right font-medium">{formatMoney(v.unitPrice)}</td>
                <td className="px-4 py-3 text-right">
                  {v.costPrice != null ? formatMoney(v.costPrice) : '—'}
                </td>
                <td className="px-4 py-3 text-right">
                  {v.averageCost != null ? formatMoney(v.averageCost) : '—'}
                </td>
                <td className="px-4 py-3 text-right">
                  {v.reorderLevel != null ? v.reorderLevel : '—'}
                </td>
                <td className="px-4 py-3">
                  {v.isActive ? (
                    <Badge variant="success">Active</Badge>
                  ) : (
                    <Badge variant="neutral">Inactive</Badge>
                  )}
                </td>
                {hasManagePermission ? (
                  <td className="px-4 py-3 text-right">
                    <Menu
                      items={buildMenuItems(v)}
                      label={`Actions for ${variantLabel(v)}`}
                      triggerClassName="touch-target-coarse"
                    />
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

/**
 * `<tab:` presentation of a single variant. Same actions as the row; label /
 * value pairs stacked so the LKR-prefixed prices don't crowd the SKU and
 * barcode identifiers on a portrait tablet's ~360mm of width.
 */
function VariantCard({
  variant,
  hasManagePermission,
  menuItems,
}: {
  variant: ProductVariant;
  hasManagePermission: boolean;
  menuItems: MenuItem[];
}) {
  const v = variant;
  return (
    <Card role="listitem" className="overflow-hidden">
      <div className="flex items-start justify-between gap-3 border-b border-border bg-muted/30 px-4 py-3">
        <div className="min-w-0 space-y-1">
          <p className="truncate text-sm font-semibold">{variantLabel(v)}</p>
          {v.isActive ? (
            <Badge variant="success">Active</Badge>
          ) : (
            <Badge variant="neutral">Inactive</Badge>
          )}
        </div>
        {hasManagePermission ? (
          <Menu
            items={menuItems}
            label={`Actions for ${variantLabel(v)}`}
            align="end"
            triggerClassName="touch-target-coarse"
          />
        ) : null}
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 px-4 py-3 text-sm">
        <VariantFact label="SKU" value={v.sku} />
        <VariantFact label="Barcode" value={v.barcode ?? '—'} />
        <VariantFact
          label="Selling price"
          value={formatMoney(v.unitPrice)}
          valueClassName="font-semibold"
        />
        <VariantFact
          label="Latest cost"
          value={v.costPrice != null ? formatMoney(v.costPrice) : '—'}
        />
        <VariantFact
          label="Average cost"
          value={v.averageCost != null ? formatMoney(v.averageCost) : '—'}
        />
        <VariantFact
          label="Reorder"
          value={v.reorderLevel != null ? String(v.reorderLevel) : '—'}
        />
      </dl>
    </Card>
  );
}

function VariantFact({
  label,
  value,
  valueClassName,
}: {
  label: string;
  value: string;
  valueClassName?: string;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={cn('mt-0.5 truncate', valueClassName)}>{value}</dd>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Inventory tab
// ─────────────────────────────────────────────────────────────────────────────

function InventoryTab({
  session,
  product,
  variants,
  branches,
  hasVariants,
  isActive,
}: {
  session: Session;
  product: ManagedProduct;
  variants: ProductVariant[];
  branches: BranchSummary[];
  hasVariants: boolean;
  isActive: boolean;
}) {
  const [rows, setRows] = React.useState<Map<string, VariantBranchInventory[]>>(new Map());
  const [loading, setLoading] = React.useState(false);
  const loadedRef = React.useRef(false);

  React.useEffect(() => {
    // Lazy on first activation: an operator who never opens Inventory never
    // pays for its per-variant round-trips. Cached forever after that; the
    // Receive Stock success path invalidates it via `onReload`.
    if (!isActive || loadedRef.current || !hasVariants) return;
    loadedRef.current = true;
    setLoading(true);
    Promise.all(
      variants.map((v) =>
        fetchVariantInventory(session, product.id, v.id)
          .then((res) => [v.id, res.branches] as const)
          .catch(() => [v.id, [] as VariantBranchInventory[]] as const),
      ),
    ).then((entries) => {
      setRows(new Map(entries));
      setLoading(false);
    });
  }, [isActive, hasVariants, session, product.id, variants]);

  // Single-variant / legacy fallback: the backend hasn't backfilled
  // BranchInventory rows for pre-D44 products, so the UI shows the parent's
  // aggregate on-hand as a single row with no per-branch breakdown. D10's
  // Phase 2.5 dual-write covers the real fill later.
  if (!hasVariants) {
    return (
      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50 text-left text-muted-foreground">
                <th className="px-4 py-3 font-medium">Product</th>
                {branches.map((b) => (
                  <th key={b.id} className="px-4 py-3 text-right font-medium">
                    {b.name}
                  </th>
                ))}
                <th className="px-4 py-3 text-right font-medium">Total</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="px-4 py-3 font-medium">{product.name}</td>
                {branches.map((b) => (
                  <td key={b.id} className="px-4 py-3 text-right text-muted-foreground">
                    —
                  </td>
                ))}
                <td className="px-4 py-3 text-right font-semibold">
                  {product.type === 'Inventory' ? product.quantityOnHand : '—'}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="border-t border-border p-3 text-xs text-muted-foreground">
          Per-branch totals will populate once branch inventory is backfilled for legacy products.
        </p>
      </Card>
    );
  }

  return (
    <Card className="overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/50 text-left text-muted-foreground">
              <th className="px-4 py-3 font-medium">Variant</th>
              {branches.map((b) => (
                <th key={b.id} className="px-4 py-3 text-right font-medium">
                  {b.name}
                </th>
              ))}
              <th className="px-4 py-3 text-right font-medium">Total</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td
                  colSpan={branches.length + 2}
                  className="px-4 py-8 text-center text-muted-foreground"
                >
                  Loading inventory...
                </td>
              </tr>
            ) : (
              variants.map((v) => {
                const branchQty = rows.get(v.id) ?? [];
                const byBranch = new Map(branchQty.map((row) => [row.branchId, row.quantityOnHand]));
                const total = branchQty.reduce((sum, r) => sum + r.quantityOnHand, 0);
                const low = v.reorderLevel != null && total <= v.reorderLevel;
                return (
                  <tr key={v.id} className="border-b border-border last:border-0 hover:bg-muted/30">
                    <td className="px-4 py-3 font-medium">{variantLabel(v)}</td>
                    {branches.map((b) => (
                      <td key={b.id} className="px-4 py-3 text-right">
                        {byBranch.get(b.id) ?? 0}
                      </td>
                    ))}
                    <td
                      className={cn(
                        'px-4 py-3 text-right font-semibold',
                        low && 'text-warning',
                      )}
                    >
                      {total}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Purchases tab
// ─────────────────────────────────────────────────────────────────────────────

function PurchasesTab({
  session,
  productId,
  variants,
  suppliers,
  suppliersLoaded,
  onNeedSuppliers,
  isActive,
}: {
  session: Session;
  productId: string;
  variants: ProductVariant[];
  suppliers: Supplier[];
  suppliersLoaded: boolean;
  onNeedSuppliers: () => void;
  isActive: boolean;
}) {
  const [variantFilter, setVariantFilter] = React.useState('');
  const [supplierFilter, setSupplierFilter] = React.useState('');
  const [from, setFrom] = React.useState('');
  const [to, setTo] = React.useState('');
  const [receipts, setReceipts] = React.useState<InventoryReceipt[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!isActive) return;
    // Suppliers are needed for the filter dropdown label rendering; load on
    // demand rather than always.
    if (!suppliersLoaded) onNeedSuppliers();
    const query: ReceiptQuery = {
      productId,
      productVariantId: variantFilter || undefined,
      supplierId: supplierFilter || undefined,
      from: from || undefined,
      to: to || undefined,
      limit: 100,
    };
    setLoading(true);
    setError(null);
    fetchReceipts(session, query)
      .then((res) => setReceipts(res.items))
      .catch((err: unknown) => {
        setReceipts([]);
        setError(err instanceof Error ? err.message : 'Could not load purchases');
      })
      .finally(() => setLoading(false));
  }, [isActive, session, productId, variantFilter, supplierFilter, from, to, suppliersLoaded, onNeedSuppliers]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-2">
        {variants.length > 0 ? (
          <div>
            <label htmlFor="pt-variant" className="text-xs text-muted-foreground">
              Variant
            </label>
            <Select
              id="pt-variant"
              value={variantFilter}
              onChange={(e) => setVariantFilter(e.target.value)}
              className="mt-0.5 w-auto"
            >
              <option value="">All variants</option>
              {variants.map((v) => (
                <option key={v.id} value={v.id}>
                  {variantLabel(v)}
                </option>
              ))}
            </Select>
          </div>
        ) : null}
        <div>
          <label htmlFor="pt-supplier" className="text-xs text-muted-foreground">
            Supplier
          </label>
          <Select
            id="pt-supplier"
            value={supplierFilter}
            onChange={(e) => setSupplierFilter(e.target.value)}
            className="mt-0.5 w-auto"
          >
            <option value="">All suppliers</option>
            {suppliers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <label htmlFor="pt-from" className="text-xs text-muted-foreground">
            From
          </label>
          <Input
            id="pt-from"
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="mt-0.5 w-auto"
          />
        </div>
        <div>
          <label htmlFor="pt-to" className="text-xs text-muted-foreground">
            To
          </label>
          <Input
            id="pt-to"
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="mt-0.5 w-auto"
          />
        </div>
      </div>

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50 text-left text-muted-foreground">
                <th className="px-4 py-3 font-medium">Date</th>
                <th className="px-4 py-3 font-medium">Variant</th>
                <th className="px-4 py-3 text-right font-medium">Qty</th>
                <th className="px-4 py-3 text-right font-medium">Unit cost</th>
                <th className="px-4 py-3 font-medium">Supplier</th>
                <th className="px-4 py-3 font-medium">Reference</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
                    Loading purchases...
                  </td>
                </tr>
              ) : error ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-danger">
                    {error}
                  </td>
                </tr>
              ) : receipts.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
                    No purchases yet.
                  </td>
                </tr>
              ) : (
                receipts.flatMap((r) =>
                  r.lines
                    .filter((l) => l.productId === productId)
                    .filter((l) => !variantFilter || l.productVariantId === variantFilter)
                    .map((l) => {
                      const variant = variants.find((v) => v.id === l.productVariantId) ?? null;
                      return (
                        <tr
                          key={`${r.id}-${l.id}`}
                          className="border-b border-border last:border-0 hover:bg-muted/30"
                        >
                          <td className="px-4 py-3 text-muted-foreground">
                            {r.receivedAt.slice(0, 10)}
                          </td>
                          <td className="px-4 py-3">
                            {variant ? variantLabel(variant) : '—'}
                          </td>
                          <td className="px-4 py-3 text-right font-medium">
                            {l.quantityReceived}
                          </td>
                          <td className="px-4 py-3 text-right">{formatMoney(l.unitCost)}</td>
                          <td className="px-4 py-3">{r.supplierName ?? '—'}</td>
                          <td className="px-4 py-3 text-muted-foreground">
                            {[r.invoiceReference, r.grnReference].filter(Boolean).join(' · ') ||
                              r.receiptNumber}
                          </td>
                        </tr>
                      );
                    }),
                )
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
