'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import * as React from 'react';
import { ArrowLeft } from 'lucide-react';

import { SupplierForm } from '@/components/suppliers/supplier-form';
import { SupplierEmptyState, SupplierErrorState } from '@/components/suppliers/supplier-states';
import { Card } from '@/components/ui/card';
import { useAuth } from '@/lib/auth';
import { deriveSupplierAccess } from '@/lib/suppliers/access';
import { fetchSupplier } from '@/lib/suppliers/suppliers-api';
import type { Supplier } from '@/lib/suppliers/types';

export default function EditSupplierPage() {
  const { session } = useAuth();
  const access = deriveSupplierAccess(session?.user.permissions ?? []);
  const { supplierId } = useParams<{ supplierId: string }>();

  const [supplier, setSupplier] = React.useState<Supplier | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!session || !access.canManage || !supplierId) return;
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
  }, [session, access.canManage, supplierId]);

  if (session && !access.canManage) {
    return (
      <Card>
        <SupplierEmptyState
          title="You don’t have permission to edit vendors"
          description="Editing vendors is available to owners and purchasing staff."
        />
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <Link
          href={`/suppliers/${supplierId}`}
          className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
        >
          <ArrowLeft className="h-4 w-4" /> Back to profile
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">Edit vendor</h1>
      </div>

      {loading ? (
        <p className="py-16 text-center text-sm text-muted-foreground">Loading…</p>
      ) : error || !supplier ? (
        <Card>
          <SupplierErrorState message={error ?? 'Vendor not found'} />
        </Card>
      ) : session ? (
        <SupplierForm session={session} supplier={supplier} />
      ) : null}
    </div>
  );
}
