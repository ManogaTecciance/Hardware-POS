'use client';

import { PageHeader } from '@/components/page-header';
import { KitchenBoard } from '@/components/restaurant/kitchen/kitchen-board';
import { Card, CardContent } from '@/components/ui/card';
import { useAuth } from '@/lib/auth';

/**
 * Kitchen board (Phase F).
 *
 * Shows every KOT for the active branch with its print status and last
 * attempt. Chefs and expeditors can reprint, mark a paper receipt as
 * printed manually, or record a failed print for the audit trail.
 */
export default function KitchenPage() {
  const { session } = useAuth();
  if (!session) return null;

  if (!session.branchId) {
    return (
      <div className="space-y-6">
        <PageHeader title="Kitchen" description="Kitchen tickets and preparation status." />
        <Card>
          <CardContent className="py-16 text-center text-sm text-muted-foreground">
            This user has no active branch. Ask an administrator to grant branch access
            before opening the kitchen board.
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Kitchen"
        description={`${session.branchName} — live kitchen tickets and reprints.`}
      />
      <KitchenBoard session={session} branchId={session.branchId} />
    </div>
  );
}
