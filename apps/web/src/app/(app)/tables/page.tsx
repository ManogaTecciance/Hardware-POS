'use client';

import * as React from 'react';

import { PageHeader } from '@/components/page-header';
import { TableFloor } from '@/components/restaurant/tables/table-floor';
import { Card, CardContent } from '@/components/ui/card';
import { useAuth } from '@/lib/auth';

/**
 * Tables page (Phase C).
 *
 * A visual floor plan grouped by dining area. Each card is a real table row
 * (backend-truth) with its current status, capacity and — when a session is
 * open — the session summary the operator needs to act on it.
 *
 * Administration of areas and the physical table roster lives at the top of
 * the same page: keeping "which areas exist" and "which tables I can seat"
 * side by side is the fastest way to add a new outdoor table between
 * services.
 */
export default function TablesPage() {
  const { session, hasPermission } = useAuth();
  if (!session) return null;

  if (!session.branchId) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Tables"
          description="Dining areas, restaurant tables and the live floor."
        />
        <Card>
          <CardContent className="py-16 text-center text-sm text-muted-foreground">
            This user has no active branch. Ask an administrator to grant branch access
            before opening the floor.
          </CardContent>
        </Card>
      </div>
    );
  }

  const canManageConfig = hasPermission('restaurant:config:manage');

  return (
    <div className="space-y-6">
      <PageHeader
        title="Tables"
        description={`${session.branchName} — live floor and area management.`}
      />
      <TableFloor session={session} branchId={session.branchId} canManage={canManageConfig} />
    </div>
  );
}
