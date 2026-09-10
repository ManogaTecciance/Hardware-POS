'use client';

import { PageHeader } from '@/components/page-header';
import { KitchenHistory } from '@/components/restaurant/kitchen/kitchen-history';
import { Card, CardContent } from '@/components/ui/card';
import { useAuth } from '@/lib/auth';

/**
 * Ticket history (D142, D150).
 *
 * Everything this branch's kitchen holds, today's tickets included. The board's
 * Done lane is cut to the shop's day so it stays readable during service; this
 * is where the rest of it lives, paged and searchable.
 *
 * D150 — "holds", not "has bumped". The list used to be filtered to finished
 * tickets, so a round still queued or on the pass appeared on this screen
 * nowhere at all: an operator searching a ticket number was told the kitchen
 * had no such ticket while it sat on the board in front of them. The wording
 * here promised exactly that filter, so it moves with it.
 */
export default function KitchenHistoryPage() {
  const { session } = useAuth();
  if (!session) return null;

  if (!session.branchId) {
    return (
      <div className="space-y-6">
        <PageHeader title="Ticket history" description="Every ticket this kitchen holds." />
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
        description="Every ticket this kitchen holds — still on the pass or already bumped, today's included."
      />
      <KitchenHistory session={session} branchId={session.branchId} />
    </div>
  );
}
