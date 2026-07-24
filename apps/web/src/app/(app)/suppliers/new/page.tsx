'use client';

import Link from 'next/link';
import * as React from 'react';
import { ArrowLeft } from 'lucide-react';

import { SupplierForm } from '@/components/suppliers/supplier-form';
import { SupplierEmptyState } from '@/components/suppliers/supplier-states';
import { Card } from '@/components/ui/card';
import { useAuth } from '@/lib/auth';
import { deriveSupplierAccess } from '@/lib/suppliers/access';

export default function NewSupplierPage() {
  const { session } = useAuth();
  const access = deriveSupplierAccess(session?.user.permissions ?? []);

  if (session && !access.canManage) {
    return (
      <Card>
        <SupplierEmptyState
          title="You don’t have permission to add vendors"
          description="Adding vendors is available to owners and purchasing staff."
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
        <h1 className="text-2xl font-semibold tracking-tight">Add vendor</h1>
        <p className="text-sm text-muted-foreground">
          The same fields QuickBooks stores for a vendor — name is the only required one.
        </p>
      </div>

      {session ? (
        <SupplierForm session={session} />
      ) : (
        <p className="py-16 text-center text-sm text-muted-foreground">Loading…</p>
      )}
    </div>
  );
}
