'use client';

import { PageHeader } from '@/components/page-header';
import { KitchenBoard } from '@/components/restaurant/kitchen/kitchen-board';
import { Card, CardContent } from '@/components/ui/card';
import { useAuth } from '@/lib/auth';

/**
 * Kitchen board (Phase F, reshaped by D68).
 *
 * The live queue for the active branch: every item a waiter confirms onto an
 * order shows up here, and kitchen staff mark each ticket done when the food
 * is up. Nothing prints — this screen IS the delivery.
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
        description={`${session.branchName} — live tickets. Mark each one done when the food is up.`}
      />
      <KitchenBoard session={session} branchId={session.branchId} />
    </div>
  );
}
