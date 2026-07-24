'use client';

import { Check, Search } from 'lucide-react';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Drawer } from '@/components/ui/drawer';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { Session } from '@/lib/auth';
import {
  linkSupplierProducts,
  searchLinkableProducts,
  type LinkableProduct,
} from '@/lib/suppliers/suppliers-api';
import type { SupplierProductLinkInput } from '@/lib/suppliers/types';
import { cn } from '@/lib/utils';

/**
 * Link existing products to a supplier. Searches the existing product catalog —
 * it never creates duplicate products — and a product may be linked to several
 * suppliers. Optional default cost / MOQ / lead time apply to all selections;
 * per-product details can be refined later.
 */
export function SupplierProductLinkDrawer({
  open,
  session,
  supplierId,
  existingProductIds,
  onClose,
  onLinked,
}: {
  open: boolean;
  session: Session;
  supplierId: string;
  existingProductIds: string[];
  onClose: () => void;
  onLinked: () => void;
}) {
  const [term, setTerm] = React.useState('');
  const [results, setResults] = React.useState<LinkableProduct[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [selected, setSelected] = React.useState<Map<string, LinkableProduct>>(new Map());
  const [cost, setCost] = React.useState('');
  const [moq, setMoq] = React.useState('');
  const [lead, setLead] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (open) {
      setSelected(new Map());
      setTerm('');
      setCost('');
      setMoq('');
      setLead('');
      setError(null);
    }
  }, [open]);

  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    const t = window.setTimeout(() => {
      searchLinkableProducts(session, term)
        .then((r) => !cancelled && setResults(r.filter((p) => !existingProductIds.includes(p.id))))
        .catch(() => !cancelled && setResults([]))
        .finally(() => !cancelled && setLoading(false));
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [open, term, session, existingProductIds]);

  const toggle = (p: LinkableProduct) => {
    setSelected((m) => {
      const next = new Map(m);
      if (next.has(p.id)) next.delete(p.id);
      else next.set(p.id, p);
      return next;
    });
  };

  const confirm = async () => {
    if (selected.size === 0) return;
    setBusy(true);
    setError(null);
    const toNum = (v: string) => (v.trim() === '' ? null : Number(v));
    const inputs: SupplierProductLinkInput[] = [...selected.values()].map((p) => ({
      productId: p.id,
      currentCost: toNum(cost),
      minOrderQty: toNum(moq),
      leadTimeDays: toNum(lead),
    }));
    try {
      await linkSupplierProducts(session, supplierId, inputs, [...selected.values()]);
      onLinked();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not link products.');
      setBusy(false);
    }
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="Link products"
      description="Search your existing products to link them to this supplier."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={confirm} disabled={selected.size === 0 || busy} isLoading={busy}>
            Link {selected.size > 0 ? `${selected.size} product${selected.size === 1 ? '' : 's'}` : 'products'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <label htmlFor="link-product-search" className="sr-only">
            Search products
          </label>
          <Input id="link-product-search" value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Search products…" className="pl-10" />
        </div>

        <ul className="space-y-1.5" aria-label="Products">
          {loading ? (
            <li className="py-6 text-center text-sm text-muted-foreground">Searching…</li>
          ) : results.length === 0 ? (
            <li className="py-6 text-center text-sm text-muted-foreground">No products found.</li>
          ) : (
            results.map((p) => {
              const on = selected.has(p.id);
              return (
                <li key={p.id}>
                  <button
                    type="button"
                    aria-pressed={on}
                    onClick={() => toggle(p)}
                    className={cn(
                      'flex w-full items-center gap-3 rounded-xl border p-3 text-left text-sm',
                      on ? 'border-primary bg-brand-50' : 'border-border hover:bg-muted',
                    )}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium text-foreground">{p.name}</span>
                      {p.sku ? <span className="block text-xs text-muted-foreground">SKU {p.sku}</span> : null}
                    </span>
                    {on ? <Check className="h-4 w-4 shrink-0 text-primary" aria-hidden /> : null}
                  </button>
                </li>
              );
            })
          )}
        </ul>

        {selected.size > 0 ? (
          <div className="space-y-3 rounded-xl border border-border p-3">
            <p className="text-xs font-medium text-muted-foreground">Optional defaults for the selected products</p>
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="link-cost">Cost (Rs.)</Label>
                <Input id="link-cost" value={cost} onChange={(e) => setCost(e.target.value)} inputMode="decimal" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="link-moq">Min. qty</Label>
                <Input id="link-moq" value={moq} onChange={(e) => setMoq(e.target.value)} inputMode="numeric" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="link-lead">Lead (days)</Label>
                <Input id="link-lead" value={lead} onChange={(e) => setLead(e.target.value)} inputMode="numeric" />
              </div>
            </div>
          </div>
        ) : null}

        {error ? <p className="text-sm text-danger">{error}</p> : null}
      </div>
    </Drawer>
  );
}
