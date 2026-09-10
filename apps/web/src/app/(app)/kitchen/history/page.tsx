'use client';

import { PageHeader } from '@/components/page-header';
import { KitchenHistory } from '@/components/restaurant/kitchen/kitchen-history';
import { Card, CardContent } from '@/components/ui/card';
import { useAuth } from '@/lib/auth';

/**
 * Ticket history (D142).
 *
 * Everything this branch's kitchen has bumped, today's tickets included. The
 * board's Done lane is cut to the shop's day so it stays readable during
 * service; this is where the rest of it lives, paged and searchable.
 */
export default function KitchenHistoryPage() {
  const { session } = useAuth();
  if (!session) return null;

  if (!session.branchId) {
    return (
      <div className="space-y-6">
        <PageHeader title="Ticket history" description="Tickets this kitchen has finished." />
        <Card>
          <CardContent className="py-16 text-center text-sm text-muted-foreground">
            This user has no active branch. Ask an administrator to grant branch access before
            opening the ticket history.
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* No branch name: this is the kitchen's own record, and leading with
          "Main Dining" named a dining area that has nothing to do with it. */}
      <PageHeader
        title="Ticket history"
        description="Every ticket this kitchen has finished, today's included."
      />
      <KitchenHistory session={session} branchId={session.branchId} />
    </div>
  );
}
