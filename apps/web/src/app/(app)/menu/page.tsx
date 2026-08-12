'use client';

import { ArrowRight, Plus } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import * as React from 'react';

import { PageHeader } from '@/components/page-header';
import { MenuBrowser } from '@/components/restaurant/menu/menu-browser';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useAuth } from '@/lib/auth';
import { useEffectiveProfile } from '@/lib/platform-profile';

/**
 * The historical Restaurant Menu screen.
 *
 * ## D45 — this route is no longer in the Restaurant navigation
 *
 * Restaurant / Cafe / Bakery tenants author every sellable item through
 * the Product Wizard now (see `/products/new`); the runtime POS reads from
 * `GET /restaurant/pos-catalogue`. Landing on `/menu` from a bookmark or a
 * typed URL renders a visible "moved to Products" card rather than the old
 * MenuBrowser — a `router.push` on mount would fight the browser back
 * button and lose the URL history the operator needs to make sense of
 * where they ended up.
 *
 * ## `?view=legacy` — support-only fallback
 *
 * The MenuBrowser is retained behind `?view=legacy` so support staff can
 * still audit historical MenuItem rows (Phase 1 menus that pre-date the
 * migration). This is intentionally undiscoverable — it is not linked
 * from anywhere and is not documented for tenants.
 */
export default function MenuPage() {
  const { session, hasPermission } = useAuth();
  const { profile } = useEffectiveProfile();
  const search = useSearchParams();

  if (!session) return null;

  const canManage = hasPermission('product:manage');
  const isRestaurantProfile =
    profile?.businessType === 'RESTAURANT' ||
    profile?.businessType === 'CAFE' ||
    profile?.businessType === 'BAKERY';
  const legacyRequested = search.get('view') === 'legacy';

  if (!session.branchId) {
    return (
      <div className="space-y-6">
        <PageHeader title="Menu" description="Menus, sections, items and modifiers." />
        <Card>
          <CardContent className="py-16 text-center text-sm text-muted-foreground">
            This user has no active branch. Ask an administrator to grant branch access
            before managing menus.
          </CardContent>
        </Card>
      </div>
    );
  }

  // D45 redirect card. Renders for any Restaurant-type tenant that arrives
  // without the `?view=legacy` opt-in.
  if (isRestaurantProfile && !legacyRequested) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Menu"
          description="This page has moved."
        />
        <Card>
          <CardContent className="space-y-4 py-10 text-center">
            <p className="text-sm text-muted-foreground">
              Restaurant tenants now manage every sellable item — dishes, drinks
              and packaged goods — from the Products screen. The POS reads the
              same catalogue directly, so there is nothing left to configure
              here.
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
    <div className="space-y-6">
      <PageHeader
        title="Menu"
        description={`${session.branchName} — menus, sections and items.`}
        actions={
          canManage ? (
            <Button asChild leftIcon={<Plus className="h-4 w-4" />}>
              <Link href="/menu/items/new">Add menu item</Link>
            </Button>
          ) : undefined
        }
      />
      <MenuBrowser session={session} branchId={session.branchId} canManage={canManage} />
    </div>
  );
}
