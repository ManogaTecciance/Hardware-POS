'use client';

import { AlertTriangle, Package, Search } from 'lucide-react';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { type Session } from '@/lib/auth';
import { fetchProducts, type ManagedProduct } from '@/lib/products-api';
import { formatMoney } from '@/lib/restaurant/labels';

interface Props {
  session: Session;
  onSelect: (product: ManagedProduct) => void;
  onBack: () => void;
}

/**
 * Search + pick an existing inventory Product to link to a Menu Item.
 *
 * Uses the existing tenant-scoped `GET /products?search=…` (Paginated<Product>)
 * so tenant isolation is enforced by the server — nothing about this dialog
 * can leak another tenant's SKUs.
 *
 * Debounce: 250 ms. Empty query hydrates the top 20 active items so an
 * operator can browse without typing. Results show the fields an operator
 * needs to identify a bottle at a glance: name, SKU, stock, base price.
 *
 * Failure modes surface near the input: a network error shows a red banner
 * that does not clear the last result set — the operator can retry without
 * losing context.
 */
export function ProductSelectorDialog({ session, onSelect, onBack }: Props) {
  const [q, setQ] = React.useState('');
  const [rows, setRows] = React.useState<ManagedProduct[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const t = setTimeout(async () => {
      try {
        const page = await fetchProducts(session, {
          search: q.trim() || undefined,
          isActive: 'true',
          pageSize: 20,
          page: 1,
        });
        if (!cancelled) {
          setRows(page.items);
          setLoading(false);
        }
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Product search failed');
        setLoading(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [q, session]);

  return (
    <Dialog
      open
      onClose={onBack}
      title="Link an existing product"
      description="Pick an inventory product to surface on this menu. The product stays the inventory authority — menu name and menu price are set on the next step."
      footer={
        <Button variant="ghost" onClick={onBack}>
          Back
        </Button>
      }
      className="max-w-2xl"
    >
      <div className="space-y-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search by product name or SKU…"
            autoFocus
            className="pl-9"
          />
          {loading ? (
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
              Searching…
            </span>
          ) : null}
        </div>

        {error ? (
          <p className="flex items-center gap-2 rounded-md border border-danger/40 bg-danger-soft p-2 text-sm text-danger">
            <AlertTriangle className="h-4 w-4" />
            {error}
          </p>
        ) : null}

        <ul
          className="max-h-[60vh] space-y-2 overflow-y-auto"
          role="listbox"
          aria-label="Product search results"
        >
          {!loading && rows.length === 0 ? (
            <li className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
              {q
                ? `No products match "${q}". Try a different name or SKU.`
                : 'No active products yet — create one under Inventory first.'}
            </li>
          ) : (
            rows.map((p) => (
              <li key={p.id} role="option" aria-selected={false}>
                <button
                  type="button"
                  onClick={() => onSelect(p)}
                  className="flex w-full items-center gap-3 rounded-lg border border-border bg-card p-3 text-left transition-colors hover:border-primary hover:bg-brand-100 focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.99] motion-reduce:transition-none motion-reduce:active:scale-100"
                >
                  <div className="rounded-md bg-primary/12 p-2 text-primary">
                    <Package className="h-5 w-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold">{p.name}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      SKU {p.sku ?? '—'}
                      {p.type === 'Inventory'
                        ? ` · Stock ${p.quantityOnHand}`
                        : ` · ${p.type}`}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-semibold text-primary">
                      {formatMoney(p.unitPrice)}
                    </p>
                    <p className="text-xs text-muted-foreground">Base price</p>
                  </div>
                </button>
              </li>
            ))
          )}
        </ul>
      </div>
    </Dialog>
  );
}
