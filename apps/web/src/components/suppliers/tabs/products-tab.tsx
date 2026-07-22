'use client';

import { Link2, Package, Plus, Star } from 'lucide-react';
import * as React from 'react';

import { SupplierProductLinkDrawer } from '@/components/suppliers/supplier-product-link-drawer';
import { SupplierEmptyState, SupplierErrorState } from '@/components/suppliers/supplier-states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Menu } from '@/components/ui/menu';
import type { Session } from '@/lib/auth';
import { formatBalance, formatDate } from '@/lib/suppliers/format';
import {
  fetchSupplierProducts,
  unlinkSupplierProduct,
  updateSupplierProductLink,
} from '@/lib/suppliers/suppliers-api';
import type { SupplierProductLink } from '@/lib/suppliers/types';

export function SupplierProductsTab({
  session,
  supplierId,
  canManage,
}: {
  session: Session;
  supplierId: string;
  canManage: boolean;
}) {
  const [links, setLinks] = React.useState<SupplierProductLink[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<SupplierProductLink | null>(null);

  const load = React.useCallback(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchSupplierProducts(session, supplierId)
      .then((l) => !cancelled && setLinks(l))
      .catch((err: unknown) => !cancelled && setError(err instanceof Error ? err.message : 'Could not load products.'))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [session, supplierId]);

  React.useEffect(() => load(), [load]);

  const setPreferred = async (l: SupplierProductLink) => {
    await updateSupplierProductLink(session, supplierId, l.id, { isPreferredSupplier: !l.isPreferredSupplier });
    load();
  };
  const unlink = async (l: SupplierProductLink) => {
    await unlinkSupplierProduct(session, supplierId, l.id);
    load();
  };

  if (loading) return <Card><div className="p-6 text-sm text-muted-foreground">Loading products…</div></Card>;
  if (error) return <Card><SupplierErrorState message={error} onRetry={load} /></Card>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {links.length} linked product{links.length === 1 ? '' : 's'}
        </p>
        {canManage ? (
          <Button size="sm" onClick={() => setDrawerOpen(true)} leftIcon={<Link2 className="h-4 w-4" />}>
            Link product
          </Button>
        ) : null}
      </div>

      {links.length === 0 ? (
        <Card>
          <SupplierEmptyState
            icon={Package}
            title="No products are linked to this supplier"
            description="Link existing products to track supplier SKUs, costs, and lead times. Linking never creates duplicate products."
            action={
              canManage ? (
                <Button size="sm" onClick={() => setDrawerOpen(true)} leftIcon={<Plus className="h-4 w-4" />}>
                  Link products
                </Button>
              ) : undefined
            }
          />
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/50 text-left text-muted-foreground">
                  <th scope="col" className="px-4 py-3 font-medium">Product</th>
                  <th scope="col" className="hidden px-4 py-3 font-medium sm:table-cell">Supplier SKU</th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">Cost</th>
                  <th scope="col" className="hidden px-4 py-3 text-right font-medium md:table-cell">MOQ</th>
                  <th scope="col" className="hidden px-4 py-3 font-medium lg:table-cell">Lead time</th>
                  <th scope="col" className="hidden px-4 py-3 font-medium lg:table-cell">Last purchased</th>
                  <th scope="col" className="px-4 py-3 font-medium">Status</th>
                  <th scope="col" className="px-4 py-3"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {links.map((l) => (
                  <tr key={l.id} className="border-b border-border last:border-0 hover:bg-muted/30">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        <span className="font-medium text-foreground">{l.productName}</span>
                        {l.isPreferredSupplier ? (
                          <Badge variant="primary"><Star className="h-3 w-3 fill-current" aria-hidden /> Preferred</Badge>
                        ) : null}
                      </div>
                      {l.productSku ? <div className="text-xs text-muted-foreground">SKU {l.productSku}</div> : null}
                    </td>
                    <td className="hidden px-4 py-3 text-muted-foreground sm:table-cell">{l.supplierSku ?? '—'}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{l.currentCost != null ? formatBalance(l.currentCost, '—') : '—'}</td>
                    <td className="hidden px-4 py-3 text-right md:table-cell">{l.minOrderQty ?? '—'}</td>
                    <td className="hidden px-4 py-3 lg:table-cell">{l.leadTimeDays != null ? `${l.leadTimeDays} days` : '—'}</td>
                    <td className="hidden px-4 py-3 text-muted-foreground lg:table-cell">{formatDate(l.lastPurchasedAt)}</td>
                    <td className="px-4 py-3">
                      {l.isActive ? <Badge variant="success">Active</Badge> : <Badge variant="neutral">Inactive</Badge>}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {canManage ? (
                        <Menu
                          label={`Actions for ${l.productName}`}
                          items={[
                            { label: 'Edit details', onSelect: () => setEditing(l) },
                            { label: l.isPreferredSupplier ? 'Remove preferred' : 'Set as preferred supplier', onSelect: () => void setPreferred(l) },
                            { label: 'Unlink product', danger: true, separatorBefore: true, onSelect: () => void unlink(l) },
                          ]}
                        />
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {canManage ? (
        <SupplierProductLinkDrawer
          open={drawerOpen}
          session={session}
          supplierId={supplierId}
          existingProductIds={links.map((l) => l.productId)}
          onClose={() => setDrawerOpen(false)}
          onLinked={load}
        />
      ) : null}

      {editing ? (
        <EditLinkDialog
          session={session}
          supplierId={supplierId}
          link={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      ) : null}
    </div>
  );
}

function EditLinkDialog({
  session,
  supplierId,
  link,
  onClose,
  onSaved,
}: {
  session: Session;
  supplierId: string;
  link: SupplierProductLink;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [sku, setSku] = React.useState(link.supplierSku ?? '');
  const [cost, setCost] = React.useState(link.currentCost != null ? String(link.currentCost) : '');
  const [moq, setMoq] = React.useState(link.minOrderQty != null ? String(link.minOrderQty) : '');
  const [lead, setLead] = React.useState(link.leadTimeDays != null ? String(link.leadTimeDays) : '');
  const [busy, setBusy] = React.useState(false);

  const save = async () => {
    setBusy(true);
    const toNum = (v: string) => (v.trim() === '' ? null : Number(v));
    await updateSupplierProductLink(session, supplierId, link.id, {
      supplierSku: sku.trim() || null,
      currentCost: toNum(cost),
      minOrderQty: toNum(moq),
      leadTimeDays: toNum(lead),
    });
    onSaved();
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="Edit supplier product"
      description={link.productName}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={save} isLoading={busy}>Save</Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-4">
        <div className="col-span-2 space-y-1.5">
          <Label htmlFor="edit-sku">Supplier SKU</Label>
          <Input id="edit-sku" value={sku} onChange={(e) => setSku(e.target.value)} placeholder="Optional" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="edit-cost">Current cost (Rs.)</Label>
          <Input id="edit-cost" value={cost} onChange={(e) => setCost(e.target.value)} inputMode="decimal" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="edit-moq">Min. order qty</Label>
          <Input id="edit-moq" value={moq} onChange={(e) => setMoq(e.target.value)} inputMode="numeric" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="edit-lead">Lead time (days)</Label>
          <Input id="edit-lead" value={lead} onChange={(e) => setLead(e.target.value)} inputMode="numeric" />
        </div>
      </div>
    </Dialog>
  );
}
