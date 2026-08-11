'use client';

import { useSearchParams } from 'next/navigation';
import * as React from 'react';

import { PageHeader } from '@/components/page-header';
import { MenuItemWizard } from '@/components/restaurant/menu/wizard/menu-item-wizard';
import { Card, CardContent } from '@/components/ui/card';
import { useAuth } from '@/lib/auth';

/**
 * Create-mode entry to the Restaurant Menu Item Wizard.
 * A `?sectionId=…` query hint pre-selects the Section select in Step 1.
 */
export default function NewMenuItemPage() {
  const { session, hasPermission } = useAuth();
  const search = useSearchParams();

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

  return (
    <div className="space-y-5">
      <PageHeader
        title="Add menu item"
        description="Create a new dish, drink or sellable menu item."
      />
      <MenuItemWizard
        session={session}
        branchId={session.branchId}
        mode="create"
        initialSectionId={search.get('sectionId') ?? undefined}
      />
    </div>
  );
}
