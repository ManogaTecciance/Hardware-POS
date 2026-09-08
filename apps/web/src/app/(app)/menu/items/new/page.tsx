'use client';

import { ArrowRight } from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';

import { PageHeader } from '@/components/page-header';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useAuth } from '@/lib/auth';
import { useEffectiveProfile } from '@/lib/platform-profile';

/**
 * Create-mode entry to the Restaurant Menu Item Wizard.
 *
 * ## D45 — Restaurant tenants land on a "create in Products" card
 *
 * The Restaurant workspace no longer creates MenuItems: the Product Wizard
 * (Restaurant) is the single authoring surface, and the runtime POS reads
 * the resulting Products directly from `/restaurant/pos-catalogue`. This
 * page keeps the wizard reachable for non-Restaurant tenants that were
 * ever routed to it (historically only Restaurant, so effectively a
 * fallback for legacy links) and blocks creation for Restaurant profiles.
 *
 * Unlike `/menu`, there is no `?view=legacy` escape hatch here: creating
 * new MenuItems is deprecated for every Restaurant tenant on D45, and a
 * hidden bypass would let a support user seed rows the runtime POS
 * cannot see.
 */
export default function NewMenuItemPage() {
  const { session, hasPermission } = useAuth();
  const { profile } = useEffectiveProfile();

  if (!session) return null;

  if (!session.branchId) {
    return (
      <Card>
        <CardContent className="py-16 text-center text-sm text-muted-foreground">
          This user has no active branch. Ask an administrator to grant branch access
          before adding menu items.
        </CardContent>
      </Card>
    );
  }

  if (!hasPermission('product:manage')) {
    return (
      <Card>
        <CardContent className="py-16 text-center text-sm text-muted-foreground">
          You do not have permission to manage the menu.
        </CardContent>
      </Card>
    );
  }

  /*
   * D60: menu authoring is gone for EVERY profile, not just food service —
   * the API answers 410 to menu-item writes, so offering the legacy wizard
   * to anyone would be offering a form that cannot save. The pointer card
   * is the page now; the wizard import went with it.
   */
  return (
      <div className="space-y-6">
        <PageHeader
          title="Add menu item"
          description="This page has moved."
        />
        <Card>
          <CardContent className="space-y-4 py-10 text-center">
            <p className="text-sm text-muted-foreground">
              New menu items are created from the Products screen. The Product
              Wizard captures pricing, variations, modifiers and stations in
              one place, and the POS reads it directly.
            </p>
            <div className="flex justify-center">
              <Link href="/products/new" className={buttonVariants()}>
                Create in Products
                <ArrowRight className="ml-1 h-4 w-4" aria-hidden />
              </Link>
            </div>
          </CardContent>
        </Card>
      </div>
    );
}
