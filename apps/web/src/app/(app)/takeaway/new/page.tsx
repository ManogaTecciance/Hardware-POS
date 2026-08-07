'use client';

import Link from 'next/link';

import { PageHeader } from '@/components/page-header';
import { TakeawayNew } from '@/components/restaurant/takeaway/takeaway-new';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useAuth } from '@/lib/auth';

/**
 * New-takeaway route. Menu picker + customer details + running order.
 * Submission is idempotent — the same key is retained for the whole page
 * lifecycle so an accidental double-tap of Place order can never open two
 * orders on the same idempotency key.
 */
export default function NewTakeawayPage() {
  const { session } = useAuth();
  if (!session) return null;

  if (!session.branchId) {
    return (
      <div className="space-y-6">
        <PageHeader title="New takeaway" description="Counter order." />
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
        title="New takeaway"
        description={`${session.branchName} — build a counter order and send it to the kitchen.`}
        actions={
          <Button asChild variant="ghost" size="sm">
            <Link href="/takeaway">Back to takeaway</Link>
          </Button>
        }
      />
      <TakeawayNew session={session} branchId={session.branchId} />
    </div>
  );
}
