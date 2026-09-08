'use client';

import { PageHeader } from '@/components/page-header';
import { RetailReports } from '@/components/reports/retail-reports';
import { RestaurantReports } from '@/components/restaurant/reports/restaurant-reports';
import { Card, CardContent } from '@/components/ui/card';
import { useAuth } from '@/lib/auth';
import { useEffectiveProfile } from '@/lib/platform-profile';

/**
 * Reports — dispatches on the tenant's FULFILMENT CAPABILITY (`8.2`).
 *
 * Table service → the restaurant analytics this screen has always shown,
 * byte for byte. Anything else → the retail reports.
 *
 * Reads a capability, never a business type — ground rule 3, D56 — and the
 * same test `/pos` uses to choose its workspace, so the two screens cannot
 * disagree about what kind of tenant this is.
 *
 * **Unresolved is its own state** (D28/D31): while the profile is loading the
 * screen shows neither report rather than defaulting to one and swapping it
 * under the operator a moment later.
 */
export default function ReportsPage() {
  const { session } = useAuth();
  const { profile } = useEffectiveProfile();
  if (!session) return null;

  if (profile === null) {
    return (
      <div className="space-y-6">
        <PageHeader title="Reports" />
        <Card>
          <CardContent className="py-16 text-center text-sm text-muted-foreground">
            Loading…
          </CardContent>
        </Card>
      </div>
    );
  }

  if (profile.capabilities.fulfilment.kind !== 'TABLE_SERVICE') {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Reports"
          description="What sold, what is left, what it earned."
        />
        <RetailReports session={session} />
      </div>
    );
  }
  if (!session.branchId) {
    return (
      <div className="space-y-6">
        <PageHeader title="Reports" description="Restaurant analytics." />
        <Card>
          <CardContent className="py-16 text-center text-sm text-muted-foreground">
            This user has no active branch.
          </CardContent>
        </Card>
      </div>
    );
  }
  return (
    <div className="space-y-6">
      <PageHeader
        title="Reports"
        description={`${session.branchName} — sales, top items, waiter performance, payments, voids and channels.`}
      />
      <RestaurantReports session={session} branchId={session.branchId} />
    </div>
  );
}
