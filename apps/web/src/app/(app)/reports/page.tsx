'use client';

import { PageHeader } from '@/components/page-header';
import { RestaurantReports } from '@/components/restaurant/reports/restaurant-reports';
import { Card, CardContent } from '@/components/ui/card';
import { useAuth } from '@/lib/auth';

/**
 * Restaurant reports (Phase I).
 *
 * Owner/manager tools for closing out the day. Six report cards, each fetched
 * independently, over an operator-chosen date range with quick "Today",
 * "Last 7 days" and "This month" presets.
 */
export default function ReportsPage() {
  const { session } = useAuth();
  if (!session) return null;
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
