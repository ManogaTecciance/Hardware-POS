'use client';

import { useParams } from 'next/navigation';
import * as React from 'react';

import { PageHeader } from '@/components/page-header';
import { MenuItemWizard } from '@/components/restaurant/menu/wizard/menu-item-wizard';
import { Card, CardContent } from '@/components/ui/card';
import { useAuth } from '@/lib/auth';

/**
 * Edit-mode entry to the Restaurant Menu Item Wizard. Reuses the same wizard
 * with `mode='edit'`; the wizard hydrates its state from the existing item
 * plus the tenant's modifier group catalogue.
 */
export default function EditMenuItemPage() {
  const { session, hasPermission } = useAuth();
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
