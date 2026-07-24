'use client';

import { Check, Info, Search } from 'lucide-react';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Drawer } from '@/components/ui/drawer';
import { Input } from '@/components/ui/input';
import type { Session } from '@/lib/auth';
import { formatBalance } from '@/lib/suppliers/format';
import { fetchQbVendors, mapQbVendor } from '@/lib/suppliers/suppliers-api';
import type { QbVendorOption, Supplier } from '@/lib/suppliers/types';
import { cn } from '@/lib/utils';

export function SupplierQuickBooksMappingDrawer({
  open,
  supplier,
  session,
  onClose,
  onMapped,
}: {
  open: boolean;
  supplier: Pick<Supplier, 'id' | 'name' | 'quickbooks'>;
  session: Session;
  onClose: () => void;
  onMapped: (updated: Supplier) => void;
}) {
  const [search, setSearch] = React.useState('');
  const [vendors, setVendors] = React.useState<QbVendorOption[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [selected, setSelected] = React.useState<QbVendorOption | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const alreadyMapped = supplier.quickbooks.vendorId != null;

  React.useEffect(() => {
    if (!open) return;
    setSelected(null);
    setSearch('');
    setError(null);
  }, [open]);

  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    const t = window.setTimeout(() => {
      fetchQbVendors(session, search)
        .then((v) => !cancelled && setVendors(v))
        .catch(() => !cancelled && setVendors([]))
        .finally(() => !cancelled && setLoading(false));
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [open, search, session]);

  const confirm = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await mapQbVendor(session, supplier.id, selected.id);
      onMapped(updated);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not map the vendor.');
      setBusy(false);
    }
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="QuickBooks vendor mapping"
      description={supplier.name}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={confirm} disabled={!selected || busy} isLoading={busy}>
            {alreadyMapped ? 'Replace mapping' : 'Confirm mapping'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex items-start gap-2 rounded-xl border border-info/30 bg-info-soft p-3 text-xs text-info">
          <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>QuickBooks remains the source of truth for bills, payments, and payable balances.</span>
        </div>

        {alreadyMapped ? (
          <div className="rounded-xl border border-border bg-muted/40 p-3 text-sm">
            <div className="text-xs text-muted-foreground">Currently mapped to</div>
            <div className="font-medium">{supplier.quickbooks.vendorName}</div>
            <p className="mt-1 text-xs text-warning">
              Replacing this mapping will point AxloPOS at a different QuickBooks vendor. Confirm the new
              vendor is correct before saving.
            </p>
          </div>
        ) : null}

        <div>
          <label htmlFor="qb-vendor-search" className="sr-only">
            Search QuickBooks vendors
          </label>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              id="qb-vendor-search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search QuickBooks vendors…"
              className="pl-10"
            />
          </div>
        </div>

        <ul className="space-y-1.5" aria-label="QuickBooks vendors">
          {loading ? (
            <li className="px-1 py-6 text-center text-sm text-muted-foreground">Loading vendors…</li>
          ) : vendors.length === 0 ? (
            <li className="px-1 py-6 text-center text-sm text-muted-foreground">
              No matching vendors found. If QuickBooks isn’t connected, connect it from the QuickBooks
              page first — vendors live under Expenses → Vendors in QuickBooks Online.
            </li>
          ) : (
            vendors.map((v) => {
              const on = selected?.id === v.id;
              return (
                <li key={v.id}>
                  <button
                    type="button"
                    aria-pressed={on}
                    onClick={() => setSelected(v)}
                    className={cn(
                      'flex w-full items-center gap-3 rounded-xl border p-3 text-left text-sm transition-colors',
                      on ? 'border-primary bg-brand-50' : 'border-border hover:bg-muted',
                    )}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium text-foreground">{v.name}</span>
                      <span className="block text-xs text-muted-foreground">
                        Balance: {formatBalance(v.balance, 'Unavailable')}
                      </span>
                    </span>
                    {on ? <Check className="h-4 w-4 shrink-0 text-primary" aria-hidden /> : null}
                  </button>
                </li>
              );
            })
          )}
        </ul>

        {error ? <p className="text-sm text-danger">{error}</p> : null}
      </div>
    </Drawer>
  );
}
