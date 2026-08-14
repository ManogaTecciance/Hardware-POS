'use client';

import { ArrowRight } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import * as React from 'react';

import { PageHeader } from '@/components/page-header';
import { MenuItemWizard } from '@/components/restaurant/menu/wizard/menu-item-wizard';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useAuth } from '@/lib/auth';
import { useEffectiveProfile } from '@/lib/platform-profile';

/**
 * Edit-mode entry to the Restaurant Menu Item Wizard.
 *
 * ## D45 — Restaurant tenants are redirected to Products
 *
 * Editing MenuItems is deprecated for Restaurant profiles alongside
 * creation (see `/menu/items/new/page.tsx`). The Product Wizard is the
 * single authoring surface, and the runtime POS reads Products directly;
 * a MenuItem edited here would drift from the row the POS renders.
 *
 * The wizard remains reachable for non-Restaurant profiles that ever
 * land on this route — historically none, but kept as a safety net for
 * legacy or misconfigured tenants.
 */
export default function EditMenuItemPage() {
  const { session, hasPermission } = useAuth();
  const { profile } = useEffectiveProfile();
  const params = useParams<{ id: string }>();

  if (!session) return null;

  if (!session.branchId || !hasPermission('product:manage')) {
    return (
      <Card>
        <CardContent className="py-16 text-center text-sm text-muted-foreground">
          You do not have permission to edit menu items.
        </CardContent>
      </Card>
    );
  }

  // D56: a capability read, not a business-type comparison. The inline
  // predicate this replaced omitted HOTEL in every copy of itself — the
  // capability is resolved once, server-side, from the domain registry.
  const isRestaurantProfile = profile?.capabilities.fulfilment.kind === 'TABLE_SERVICE';

  if (isRestaurantProfile) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Edit menu item"
          description="This page has moved."
        />
        <Card>
          <CardContent className="space-y-4 py-10 text-center">
            <p className="text-sm text-muted-foreground">
              Menu items are now edited from the Products screen. Open the
              product you want to change from there — the same fields
              (pricing, modifiers, stations) live in the Product Wizard.
            </p>
            <div className="flex justify-center">
              <Link href="/products" className={buttonVariants()}>
                Go to Products
                <ArrowRight className="ml-1 h-4 w-4" aria-hidden />
              </Link>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Edit menu item"
        description="Update details, variations, modifiers and availability."
      />
      <MenuItemWizard
        session={session}
        branchId={session.branchId}
        mode="edit"
        editingItemId={params.id}
      />
    </div>
  );
}
