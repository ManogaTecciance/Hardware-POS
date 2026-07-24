'use client';

import Link from 'next/link';
import * as React from 'react';
import { ArrowLeft } from 'lucide-react';

import { SupplierForm } from '@/components/suppliers/supplier-form';
import { SupplierEmptyState } from '@/components/suppliers/supplier-states';
import { Card } from '@/components/ui/card';
import { useAuth } from '@/lib/auth';
import { deriveSupplierAccess } from '@/lib/suppliers/access';
import { fetchSupplierCategories, fetchSupplierCodes } from '@/lib/suppliers/suppliers-api';
import type { SupplierCategoryRef } from '@/lib/suppliers/types';

export default function NewSupplierPage() {
  const { session } = useAuth();
  const access = deriveSupplierAccess(session?.user.permissions ?? []);

  const [categories, setCategories] = React.useState<SupplierCategoryRef[]>([]);
  const [codes, setCodes] = React.useState<string[]>([]);
  const [ready, setReady] = React.useState(false);

  React.useEffect(() => {
    if (!session || !access.canManage) return;
    let cancelled = false;
    Promise.all([fetchSupplierCategories(session), fetchSupplierCodes(session)])
      .then(([c, k]) => {
        if (cancelled) return;
        setCategories(c);
        setCodes(k);
      })
      .catch(() => undefined)
      .finally(() => !cancelled && setReady(true));
    return () => {
      cancelled = true;
    };
  }, [session, access.canManage]);

  if (session && !access.canManage) {
    return (
      <Card>
        <SupplierEmptyState
          title="You don’t have permission to add suppliers"
          description="Adding suppliers is available to owners and purchasing staff."
        />
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <Link href="/suppliers" className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
          <ArrowLeft className="h-4 w-4" /> Back to suppliers
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">Add supplier</h1>
        <p className="text-sm text-muted-foreground">
          Start with the essentials — you can add more business details now or later.
        </p>
      </div>

      {session && ready ? (
        <SupplierForm session={session} access={access} categoryOptions={categories} existingCodes={codes} />
      ) : (
        <p className="py-16 text-center text-sm text-muted-foreground">Loading…</p>
      )}
    </div>
  );
}
