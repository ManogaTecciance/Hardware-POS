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
import {
  fetchSupplier,
  fetchSupplierCategories,
  fetchSupplierCodes,
} from '@/lib/suppliers/suppliers-api';
import type { Supplier, SupplierCategoryRef } from '@/lib/suppliers/types';

export default function EditSupplierPage() {
  const { session } = useAuth();
  const access = deriveSupplierAccess(session?.user.permissions ?? []);
  const { supplierId } = useParams<{ supplierId: string }>();

  const [supplier, setSupplier] = React.useState<Supplier | null>(null);
  const [categories, setCategories] = React.useState<SupplierCategoryRef[]>([]);
  const [codes, setCodes] = React.useState<string[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!session || !access.canManage || !supplierId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([
      fetchSupplier(session, supplierId),
      fetchSupplierCategories(session),
      fetchSupplierCodes(session),
    ])
      .then(([s, c, k]) => {
        if (cancelled) return;
        setSupplier(s);
        setCategories(c);
        // Exclude this supplier's own code from the uniqueness set.
        setCodes(k.filter((code) => code !== s.code.toLowerCase()));
      })
      .catch((err: unknown) => !cancelled && setError(err instanceof Error ? err.message : 'Could not load the supplier.'))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [session, access.canManage, supplierId]);

  if (session && !access.canManage) {
    return (
      <Card>
        <SupplierEmptyState
          title="You don’t have permission to edit suppliers"
          description="Editing suppliers is available to owners and purchasing staff."
        />
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <Link href={`/suppliers/${supplierId}`} className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
          <ArrowLeft className="h-4 w-4" /> Back to profile
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">Edit supplier</h1>
      </div>

      {loading ? (
        <p className="py-16 text-center text-sm text-muted-foreground">Loading…</p>
      ) : error || !supplier ? (
        <Card>
          <SupplierErrorState message={error ?? 'Supplier not found'} />
        </Card>
      ) : session ? (
        <SupplierForm
          session={session}
          access={access}
          supplier={supplier}
          categoryOptions={categories}
          existingCodes={codes}
        />
      ) : null}
    </div>
  );
}
