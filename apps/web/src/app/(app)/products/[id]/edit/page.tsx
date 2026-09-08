'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import * as React from 'react';
import { ArrowLeft } from 'lucide-react';

import { ProductForm } from '@/components/products/product-form';
import { Card, CardContent } from '@/components/ui/card';
import { useAuth } from '@/lib/auth';
import { isAdminLevelRole, Permission } from '@/lib/permissions';
import { fetchCategoryTree, fetchProduct, type CategoryNode, type ManagedProduct } from '@/lib/products-api';

export default function EditProductPage() {
  const { session, hasPermission } = useAuth();
  const canManage = hasPermission(Permission.PRODUCT_MANAGE);
  const { id } = useParams<{ id: string }>();

  const [product, setProduct] = React.useState<ManagedProduct | null>(null);
  const [categories, setCategories] = React.useState<CategoryNode[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!session || !id) return;
    let cancelled = false;
    setLoading(true);
    Promise.all([fetchProduct(session, id), fetchCategoryTree(session).catch(() => [])])
      .then(([p, cats]) => {
        if (cancelled) return;
        setProduct(p);
        setCategories(cats);
      })
      .catch((err: unknown) => !cancelled && setError(err instanceof Error ? err.message : 'Could not load product'))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [session, id]);

  if (!session) return null;

  return (
    <div className="space-y-6">
      <Link
        href={`/products/${id}`}
        className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
      >
        <ArrowLeft className="h-4 w-4" /> Back to product
      </Link>

      {loading ? (
        <p className="py-16 text-center text-sm text-muted-foreground">Loading…</p>
      ) : error || !product ? (
        <Card>
          <CardContent className="py-16 text-center text-sm text-danger">
            {error ?? 'Product not found'}
          </CardContent>
        </Card>
      ) : !canManage ? (
        <Card>
          <CardContent className="py-16 text-center text-sm text-muted-foreground">
            You don’t have permission to edit products.
          </CardContent>
        </Card>
      ) : (
        <ProductForm
          session={session}
          categories={categories}
          product={product}
          isAdmin={isAdminLevelRole(session.user.role)}
        />
      )}
    </div>
  );
}
