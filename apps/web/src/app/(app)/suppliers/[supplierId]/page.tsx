'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import * as React from 'react';
import { ArrowLeft, Link2, Pencil, Trash2, Unlink } from 'lucide-react';

import { SupplierAvatar } from '@/components/suppliers/supplier-avatar';
import { SupplierActiveBadge, SupplierQuickBooksBadge } from '@/components/suppliers/supplier-badges';
import { SupplierDeleteDialog } from '@/components/suppliers/supplier-delete-dialog';
import { SupplierQuickBooksMappingDrawer } from '@/components/suppliers/supplier-quickbooks-mapping-drawer';
import { SupplierErrorState } from '@/components/suppliers/supplier-states';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useAuth } from '@/lib/auth';
import { deriveSupplierAccess } from '@/lib/suppliers/access';
import { formatBalance, formatDateOnly } from '@/lib/suppliers/format';
import { fetchSupplier, unmapQbVendor } from '@/lib/suppliers/suppliers-api';
import type { Supplier } from '@/lib/suppliers/types';

export default function SupplierProfilePage() {
  const { session } = useAuth();
  const access = deriveSupplierAccess(session?.user.permissions ?? []);
  const { supplierId } = useParams<{ supplierId: string }>();
  const router = useRouter();

  const [supplier, setSupplier] = React.useState<Supplier | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [mapOpen, setMapOpen] = React.useState(false);
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const [unmapBusy, setUnmapBusy] = React.useState(false);

  React.useEffect(() => {
    if (!session || !access.canView || !supplierId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchSupplier(session, supplierId)
      .then((s) => !cancelled && setSupplier(s))
      .catch(
        (err: unknown) =>
          !cancelled && setError(err instanceof Error ? err.message : 'Could not load the vendor.'),
      )
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [session, access.canView, supplierId]);

  const onUnmap = async () => {
    if (!session || !supplier) return;
    setUnmapBusy(true);
    try {
      setSupplier(await unmapQbVendor(session, supplier.id));
    } catch {
      /* keep the profile usable; the next refresh re-syncs state */
    } finally {
      setUnmapBusy(false);
    }
  };

  if (loading) {
    return <p className="py-16 text-center text-sm text-muted-foreground">Loading…</p>;
  }
  if (error || !supplier) {
    return (
      <Card>
        <SupplierErrorState message={error ?? 'Vendor not found'} />
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <Link href="/suppliers" className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
          <ArrowLeft className="h-4 w-4" /> Back to suppliers
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <SupplierAvatar name={supplier.name} size="lg" />
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">{supplier.name}</h1>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <SupplierActiveBadge isActive={supplier.isActive} />
                <SupplierQuickBooksBadge status={supplier.quickbooks.status} />
              </div>
            </div>
          </div>
          {access.canManage ? (
            <div className="flex items-center gap-2">
              <Link href={`/suppliers/${supplier.id}/edit`} className={buttonVariants({ variant: 'outline' })}>
                <Pencil className="h-4 w-4" />
                Edit
              </Link>
              {access.canDelete ? (
                <Button variant="outline" onClick={() => setDeleteOpen(true)}>
                  <Trash2 className="h-4 w-4 text-danger" />
                  Delete
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Vendor details</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
              <Detail label="Company" value={supplier.company} />
              <Detail label="Email" value={supplier.email} />
              <Detail label="Phone" value={supplier.phone} />
              <Detail label="Mobile" value={supplier.mobile} />
              <Detail label="Fax" value={supplier.fax} />
              <Detail label="Website" value={supplier.website} link />
              <Detail label="Tax ID number" value={supplier.taxId} />
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>QuickBooks</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {supplier.quickbooks.vendorId ? (
              <>
                <div>
                  <div className="text-xs text-muted-foreground">Mapped vendor</div>
                  <div className="font-medium">{supplier.quickbooks.vendorName}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">Last synced</div>
                  <div>{formatDateOnly(supplier.quickbooks.lastSyncedAt)}</div>
                </div>
                {access.canMapQuickBooks ? (
                  <div className="flex flex-wrap gap-2 pt-1">
                    <Button variant="outline" size="sm" onClick={() => setMapOpen(true)}>
                      <Link2 className="h-4 w-4" />
                      Change mapping
                    </Button>
                    <Button variant="ghost" size="sm" onClick={onUnmap} isLoading={unmapBusy}>
                      <Unlink className="h-4 w-4" />
                      Unmap
                    </Button>
                  </div>
                ) : null}
              </>
            ) : (
              <>
                <p className="text-muted-foreground">
                  Not connected to a QuickBooks vendor. QuickBooks owns bills, payments, and the live
                  payable balance.
                </p>
                {access.canMapQuickBooks ? (
                  <Button variant="outline" size="sm" onClick={() => setMapOpen(true)}>
                    <Link2 className="h-4 w-4" />
                    Map vendor
                  </Button>
                ) : null}
              </>
            )}
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Address</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
              <Detail label="Street" value={supplier.street} />
              <Detail label="City" value={supplier.city} />
              <Detail label="Province / Region / State" value={supplier.province} />
              <Detail label="Postal code" value={supplier.postalCode} />
              <Detail label="Country" value={supplier.country} />
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Opening balance</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div>
              <div className="text-xs text-muted-foreground">Amount (as entered)</div>
              <div className="text-lg font-semibold tabular-nums">
                {formatBalance(supplier.openingBalance)}
              </div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">As of</div>
              <div>{formatDateOnly(supplier.openingBalanceDate)}</div>
            </div>
            <p className="text-xs text-muted-foreground">
              The live payable balance lives in QuickBooks (Expenses → Vendors).
            </p>
          </CardContent>
        </Card>
      </div>

      {session ? (
        <>
          <SupplierQuickBooksMappingDrawer
            open={mapOpen}
            supplier={supplier}
            session={session}
            onClose={() => setMapOpen(false)}
            onMapped={setSupplier}
          />
          <SupplierDeleteDialog
            open={deleteOpen}
            supplier={supplier}
            session={session}
            onClose={() => setDeleteOpen(false)}
            onDeleted={() => router.replace('/suppliers')}
          />
        </>
      ) : null}
    </div>
  );
}

function Detail({ label, value, link }: { label: string; value: string | null; link?: boolean }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 break-words">
        {value ? (
          link ? (
            <a href={value} target="_blank" rel="noreferrer" className="text-primary hover:underline">
              {value}
            </a>
          ) : (
            value
          )
        ) : (
          '—'
        )}
      </dd>
    </div>
  );
}
