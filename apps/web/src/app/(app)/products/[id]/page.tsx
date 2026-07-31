'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import * as React from 'react';
import { ArrowLeft, Pencil, Printer, RefreshCw } from 'lucide-react';

import { PrintLabelsDialog } from '@/components/labels/print-labels-dialog';
import { ProductImage } from '@/components/product-image';

import { SyncBadge } from '@/components/quickbooks/sync-badge';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useAuth } from '@/lib/auth';
import { Permission } from '@/lib/permissions';
import {
  fetchProduct,
  resolveImageUrl,
  syncProductToQuickBooks,
  type ManagedProduct,
} from '@/lib/products-api';
import { formatMoney } from '@/lib/utils';

export default function ProductDetailPage() {
  const { session, hasPermission } = useAuth();
  const canManage = hasPermission(Permission.PRODUCT_MANAGE);
  const canSyncQb = hasPermission(Permission.QUICKBOOKS_MANAGE);
  const { id } = useParams<{ id: string }>();

  const [product, setProduct] = React.useState<ManagedProduct | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [labelOpen, setLabelOpen] = React.useState(false);
  const [reloadKey, setReloadKey] = React.useState(0);

  React.useEffect(() => {
    if (!session || !id) return;
    let cancelled = false;
    setLoading(true);
    fetchProduct(session, id)
      .then((p) => !cancelled && setProduct(p))
      .catch((err: unknown) => !cancelled && setError(err instanceof Error ? err.message : 'Could not load product'))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [session, id, reloadKey]);

  const handleSync = async () => {
    if (!session || !product) return;
    setBusy(true);
    try {
      await syncProductToQuickBooks(session, product.id);
      setReloadKey((k) => k + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sync failed');
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <p className="py-16 text-center text-sm text-muted-foreground">Loading…</p>;

  if (error || !product) {
    return (
      <div className="space-y-4">
        <Link href="/products" className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
          <ArrowLeft className="h-4 w-4" /> Back to products
        </Link>
        <Card>
          <CardContent className="py-16 text-center text-sm text-danger">{error ?? 'Product not found'}</CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <Link href="/products" className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
            <ArrowLeft className="h-4 w-4" /> Back to products
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight">{product.name}</h1>
          <p className="text-sm text-muted-foreground">{product.sku ?? 'No SKU'}</p>
        </div>
        <div className="flex items-center gap-2">
          {canSyncQb && !product.quickbooksItemId ? (
            <Button variant="outline" onClick={handleSync} disabled={busy}>
              <RefreshCw className="h-4 w-4" />
              Sync to QuickBooks
            </Button>
          ) : null}
          <Button variant="outline" onClick={() => setLabelOpen(true)}>
            <Printer className="h-4 w-4" />
            Print label
          </Button>
          {canManage ? (
            <Link href={`/products/${product.id}/edit`} className={buttonVariants()}>
              <Pencil className="h-4 w-4" />
              Edit
            </Link>
          ) : null}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {product.isActive ? <Badge variant="success">Active</Badge> : <Badge variant="danger">Inactive</Badge>}
        {product.quickbooksItemId ? (
          <Badge variant="primary">QuickBooks-managed</Badge>
        ) : (
          <Badge variant="neutral">Local (not synced)</Badge>
        )}
        <SyncBadge status={product.syncStatus} />
      </div>

      <div className="grid gap-6 lg:grid-cols-[280px_1fr]">
        <Card>
          <CardContent className="p-4">
            <ProductImage
              src={resolveImageUrl(product.imageUrl)}
              alt={product.name}
              className="aspect-square w-full"
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Details</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
            <Detail label="Item type" value={product.type === 'NonInventory' ? 'Non-Inventory' : product.type} />
            <Detail label="SKU" value={product.sku ?? '—'} />
            <Detail label="Sales price/rate" value={formatMoney(product.unitPrice)} />
            <Detail label="Purchase cost" value={product.costPrice != null ? formatMoney(product.costPrice) : '—'} />
            <Detail label="Purchase description" value={product.purchaseDescription ?? '—'} />
            <Detail
              label="Quantity on hand"
              value={product.type === 'Inventory' ? String(product.quantityOnHand) : 'Not tracked'}
            />
            <Detail
              label="Quantity as of date"
              value={product.quantityAsOfDate ? product.quantityAsOfDate.slice(0, 10) : '—'}
            />
            <Detail label="Reorder point" value={product.reorderLevel != null ? String(product.reorderLevel) : '—'} />
            <Detail label="Income account" value={product.incomeAccount ?? 'Auto-assigned on sync'} />
            <Detail label="Expense account" value={product.expenseAccount ?? 'Auto-assigned on sync'} />
            <Detail
              label="Inventory asset account"
              value={product.type === 'Inventory' ? (product.inventoryAssetAccount ?? 'Auto-assigned on sync') : '—'}
            />
            <Detail label="QuickBooks item ID" value={product.quickbooksItemId ?? 'Not synced'} />
            {product.description ? (
              <div className="sm:col-span-2">
                <div className="text-xs text-muted-foreground">Description</div>
                <p className="mt-0.5">{product.description}</p>
              </div>
            ) : null}
          </CardContent>
        </Card>
      </div>

      {session ? (
        <PrintLabelsDialog
          session={session}
          open={labelOpen}
          onClose={() => setLabelOpen(false)}
          targets={[
            {
              id: product.id,
              name: product.name,
              sku: product.sku,
              price: product.unitPrice,
            },
          ]}
        />
      ) : null}
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
