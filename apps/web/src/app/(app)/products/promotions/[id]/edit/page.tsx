'use client';

import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import * as React from 'react';

import { PromotionEditor } from '@/components/products/promotions/promotion-editor';
import { Card, CardContent } from '@/components/ui/card';
import { useAuth } from '@/lib/auth';
import { Permission } from '@/lib/permissions';
import { fetchPromotion, type Promotion } from '@/lib/products/promotions-api';

/**
 * Edit an existing promotion. Pre-fetches the promotion so the shell can gate
 * on 404 before mounting the editor; the editor also refetches on its own if
 * `initialPromotion` isn't supplied (defence in depth against a stale link).
 */
export default function EditPromotionPage() {
  const { session, hasPermission } = useAuth();
  const canManage = hasPermission(Permission.PRODUCT_MANAGE);
  const { id } = useParams<{ id: string }>();

  const [promo, setPromo] = React.useState<Promotion | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!session || !id) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchPromotion(session, id)
      .then((p) => {
        if (!cancelled) setPromo(p);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load promotion');
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [session, id]);

  if (!session) return null;

  return (
    <div className="space-y-6">
      <Link
        href="/products/promotions"
        className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
      >
        <ArrowLeft className="h-4 w-4" /> Back to promotions
      </Link>

      {loading ? (
        <p className="py-16 text-center text-sm text-muted-foreground">Loading…</p>
      ) : error || !promo ? (
        <Card>
          <CardContent className="py-16 text-center text-sm text-danger">
            {error ?? 'Promotion not found'}
          </CardContent>
        </Card>
      ) : !canManage ? (
        <Card>
          <CardContent className="py-16 text-center text-sm text-muted-foreground">
            You don&apos;t have permission to edit promotions.
          </CardContent>
        </Card>
      ) : (
        <PromotionEditor session={session} promotionId={promo.id} initialPromotion={promo} />
      )}
    </div>
  );
}
