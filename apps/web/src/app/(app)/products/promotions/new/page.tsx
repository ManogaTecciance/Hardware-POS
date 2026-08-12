'use client';

import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';

import { PromotionEditor } from '@/components/products/promotions/promotion-editor';
import { Card, CardContent } from '@/components/ui/card';
import { useAuth } from '@/lib/auth';
import { Permission } from '@/lib/permissions';

/**
 * Create a new promotion. Deliberately thin — the editor owns state and the
 * save cascade; this file gates on auth + permission and provides the back
 * link chrome.
 *
 * `?linkProductId=` is read inside the editor to preselect that product in the
 * item picker (the wizard opens the create route in a new tab with this query
 * when the operator clicks "Create new promotion" from Step 3).
 */
export default function NewPromotionPage() {
  const { session, hasPermission } = useAuth();
  const canManage = hasPermission(Permission.PRODUCT_MANAGE);

  if (!session) return null;

  return (
    <div className="space-y-6">
      <Link
        href="/products/promotions"
        className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
      >
        <ArrowLeft className="h-4 w-4" /> Back to promotions
      </Link>

      {!canManage ? (
        <Card>
          <CardContent className="py-16 text-center text-sm text-muted-foreground">
            You don&apos;t have permission to create promotions.
          </CardContent>
        </Card>
      ) : (
        <PromotionEditor session={session} />
      )}
    </div>
  );
}
