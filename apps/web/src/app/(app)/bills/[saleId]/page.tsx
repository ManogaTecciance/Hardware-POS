'use client';

import Link from 'next/link';
import { use } from 'react';

import { PageHeader } from '@/components/page-header';
import { BillScreen } from '@/components/restaurant/billing/bill-screen';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useAuth } from '@/lib/auth';

interface PageProps {
  params: Promise<{ saleId: string }>;
}

/**
 * Bill route (Phase H). Owns the payment collection for one closed sale —
 * splits, tenders and audit reopens.
 */
export default function BillPage({ params }: PageProps) {
  const { saleId } = use(params);
  const { session } = useAuth();
  if (!session) return null;

  if (!session.branchId) {
    return (
      <div className="space-y-6">
        <PageHeader title="Bill" description="Payment collection." />
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
        title="Bill"
        description={`${session.branchName} — collect payments and manage splits.`}
        actions={
          <Button asChild variant="ghost" size="sm">
            <Link href="/tables">Back to floor</Link>
          </Button>
        }
      />
      <BillScreen session={session} saleId={saleId} />
    </div>
  );
}
