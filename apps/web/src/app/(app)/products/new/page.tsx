'use client';

import Link from 'next/link';
import * as React from 'react';
import { ArrowLeft } from 'lucide-react';

import { ProductForm } from '@/components/products/product-form';
import { Card, CardContent } from '@/components/ui/card';
import { useAuth } from '@/lib/auth';
import { isAdminLevelRole, Permission } from '@/lib/permissions';
import { fetchCategoryTree, type CategoryNode } from '@/lib/products-api';

export default function NewProductPage() {
  const { session, hasPermission } = useAuth();
  const canManage = hasPermission(Permission.PRODUCT_MANAGE);
  const [categories, setCategories] = React.useState<CategoryNode[]>([]);

  React.useEffect(() => {
    if (session) {
      fetchCategoryTree(session).then(setCategories).catch(() => setCategories([]));
    }
  }, [session]);

  if (!session) return null;

  return (
    <div className="space-y-6">
      <Link href="/products" className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
        <ArrowLeft className="h-4 w-4" /> Back to products
      </Link>

      {!canManage ? (
        <Card>
          <CardContent className="py-16 text-center text-sm text-muted-foreground">
            You don’t have permission to add products.
          </CardContent>
        </Card>
      ) : (
        <ProductForm
          session={session}
          categories={categories}
          isAdmin={isAdminLevelRole(session.user.role)}
        />
      )}
    </div>
  );
}
