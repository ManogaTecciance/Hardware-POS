'use client';

import { PageHeader } from '@/components/page-header';
import { TakeawayList } from '@/components/restaurant/takeaway/takeaway-list';
import { Card, CardContent } from '@/components/ui/card';
import { useAuth } from '@/lib/auth';

/**
 * Takeaway board (Phase G).
 *
 * Every takeaway order for the active branch, active on top and closed
 * beneath. Advance a row through Placed → In kitchen → Ready → Handed over
 * with the primary action; use "New takeaway" for the counter flow.
 */
export default function TakeawayPage() {
  const { session } = useAuth();
  if (!session) return null;

  if (!session.branchId) {
    return (
      <div className="space-y-6">
        <PageHeader title="Takeaway" description="Counter and collection orders." />
        <Card>
          <CardContent className="py-16 text-center text-sm text-muted-foreground">
            This user has no active branch. Ask an administrator to grant branch access
            before taking counter orders.
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Takeaway"
        description={`${session.branchName} — counter and collection orders.`}
      />
      <TakeawayList session={session} branchId={session.branchId} />
    </div>
  );
}
