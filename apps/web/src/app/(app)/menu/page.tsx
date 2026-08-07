'use client';

import * as React from 'react';

import { PageHeader } from '@/components/page-header';
import { MenuBrowser } from '@/components/restaurant/menu/menu-browser';
import { Card, CardContent } from '@/components/ui/card';
import { useAuth } from '@/lib/auth';

/**
 * The Restaurant menu screen (Phase B).
 *
 * Three-column browser: menus → sections → items. Everything reads through
 * `MenuBrowser`, which fetches lazily so opening one menu doesn't force every
 * section on the branch to load.
 */
export default function MenuPage() {
  const { session, hasPermission } = useAuth();
  if (!session) return null;

  const canManage = hasPermission('product:manage');

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

  return (
    <div className="space-y-6">
      <PageHeader
        title="Menu"
        description={`${session.branchName} — menus, sections and items.`}
      />
      <MenuBrowser session={session} branchId={session.branchId} canManage={canManage} />
    </div>
  );
}
