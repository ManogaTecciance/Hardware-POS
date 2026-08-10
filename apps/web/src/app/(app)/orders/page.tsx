'use client';

import { PageHeader } from '@/components/page-header';
import { OrdersPage } from '@/components/restaurant/orders-page/orders-page';
import { Card, CardContent } from '@/components/ui/card';
import { useAuth } from '@/lib/auth';

/**
 * `/orders` — the unified live queue across dining, takeaway and 3rd-party
 * channels (Pilot Change 2 Slice D). Retail tenants have no operational
 * order concept — for them this route shows a friendly "not part of this
 * workspace" message; the module gate on the underlying API refuses the
 * fetch either way.
 */
export default function OrdersRoute() {
  const { session } = useAuth();
  if (!session) return null;
  if (!session.branchId) {
    return (
      <div className="space-y-6">
        <PageHeader title="Orders" description="Live queue across every channel." />
        <Card>
          <CardContent className="py-16 text-center text-sm text-muted-foreground">
            This user has no active branch. Ask an administrator to grant branch access
            before opening the queue.
          </CardContent>
        </Card>
      </div>
    );
  }
  return <OrdersPage session={session} branchId={session.branchId} />;
}
