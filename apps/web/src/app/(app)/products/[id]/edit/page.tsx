'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import * as React from 'react';
import { ArrowLeft } from 'lucide-react';

import { ProductWizard } from '@/components/products/wizard/product-wizard';
import { Card, CardContent } from '@/components/ui/card';
import { useAuth } from '@/lib/auth';
import { Permission } from '@/lib/permissions';
import {
  fetchCategoryTree,
  fetchProduct,
  type CategoryNode,
  type ManagedProduct,
} from '@/lib/products-api';

/**
 * Edit Product route — wraps the D44 wizard in edit mode. The wizard fetches
 * variants + dimensions on its own from the product id; we still pre-fetch
 * the parent product here so the wrapper can gate on existence before the
 * wizard mounts.
 */
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
      .catch(
        (err: unknown) =>
          !cancelled && setError(err instanceof Error ? err.message : 'Could not load product'),
      )
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
        <p className="py-16 text-center text-sm text-muted-foreground">Loading...</p>
      ) : error || !product ? (
        <Card>
          <CardContent className="py-16 text-center text-sm text-danger">
            {error ?? 'Product not found'}
          </CardContent>
        </Card>
      ) : !canManage ? (
        <Card>
          <CardContent className="py-16 text-center text-sm text-muted-foreground">
            You don&apos;t have permission to edit products.
          </CardContent>
        </Card>
      ) : (
        <ProductWizard
          mode="edit"
          session={session}
          categories={categories}
          initialProductId={product.id}
          initialProduct={product}
        />
      )}
    </div>
  );
}
