'use client';

import * as React from 'react';

import { PageHeader } from '@/components/page-header';
import { WorkspaceTab } from '@/components/settings/workspace-tab';
import { Card, CardContent } from '@/components/ui/card';
import { useAuth } from '@/lib/auth';
import { Permission } from '@/lib/permissions';

/**
 * Workspace configuration as a standalone route.
 *
 * D95 moved this content into a Settings tab, where the PO asked for it. The
 * URL stays as a thin shell for two reasons: it is bookmarkable and was linked
 * from the settings screen until now, and it still renders when
 * `GET /v1/settings` fails — the tab cannot, because the settings page returns
 * its error card before the tab strip exists.
 *
 * The body, the read-only reasoning and the three-state handling all live in
 * `WorkspaceTab` so the two entry points cannot drift.
 */
export default function BusinessSettingsPage() {
  const { hasPermission } = useAuth();

  // Consistent with the parent settings screen: the route is hidden from anyone
  // without SETTINGS_MANAGE, so arriving here means a typed URL.
  if (!hasPermission(Permission.SETTINGS_MANAGE)) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Workspace configuration"
          description="What this workspace is set up as, and which features it includes."
        />
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-16 text-center">
            <p className="text-sm font-medium text-foreground" role="status">
              You don’t have access to settings
            </p>
            <p className="max-w-sm text-sm text-muted-foreground">
              Workspace configuration is available to owners and administrators.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Workspace configuration"
        description="What this workspace is set up as, and which features it includes."
      />
      <WorkspaceTab />
    </div>
  );
}
