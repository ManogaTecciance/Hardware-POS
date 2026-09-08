'use client';

import Link from 'next/link';
import * as React from 'react';
import { ArrowLeft } from 'lucide-react';

import { ProductWizard } from '@/components/products/wizard/product-wizard';
import { Card, CardContent } from '@/components/ui/card';
import { useAuth } from '@/lib/auth';
import { Permission } from '@/lib/permissions';
import { fetchCategoryTree, type CategoryNode } from '@/lib/products-api';

/**
 * Add Product route — wraps the D44 wizard. The wrapper deliberately stays
 * thin (title link, permission gate, category pre-fetch) so the wizard owns
 * all step navigation and validation.
 */
export default function NewProductPage() {
  const { session, hasPermission } = useAuth();
  const canManage = hasPermission(Permission.PRODUCT_MANAGE);
  const [categories, setCategories] = React.useState<CategoryNode[]>([]);

  React.useEffect(() => {
    if (session) {
      fetchCategoryTree(session)
        .then(setCategories)
        .catch(() => setCategories([]));
    }
  }, [session]);

  if (!session) return null;

  return (
    <div className="space-y-6">
      <Link
        href="/products"
        className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
      >
        <ArrowLeft className="h-4 w-4" /> Back to products
      </Link>

      {!canManage ? (
        <Card>
          <CardContent className="py-16 text-center text-sm text-muted-foreground">
            You don&apos;t have permission to add products.
          </CardContent>
        </Card>
      ) : (
        <ProductWizard mode="create" session={session} categories={categories} />
      )}
    </div>
  );
}
