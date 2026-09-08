'use client';

import Link from 'next/link';
import { use } from 'react';

import { PageHeader } from '@/components/page-header';
import { OrderEntry } from '@/components/restaurant/orders/order-entry';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useAuth } from '@/lib/auth';

interface PageProps {
  params: Promise<{ sessionId: string }>;
}

/**
 * Order-entry screen for one open table session.
 *
 * Route: `/tables/session/[sessionId]`. Reached from the tables floor when a
 * waiter taps "View order" on an occupied card. Everything about this screen
 * is scoped to `sessionId`: the guard on the child component keeps the
 * running draft in sync with `GET /table-sessions/:id/detail`.
 */
export default function SessionOrderPage({ params }: PageProps) {
  const { sessionId } = use(params);
  const { session } = useAuth();
  if (!session) return null;

  if (!session.branchId) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Session"
          description="Building a round for a dining session."
        />
        <Card>
          <CardContent className="py-16 text-center text-sm text-muted-foreground">
            This user has no active branch. Ask an administrator to grant branch access
            before opening the floor.
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Order"
        description={`${session.branchName} — build and send this session's rounds.`}
        actions={
          <Button asChild variant="ghost" size="sm">
            <Link href="/tables">Back to floor</Link>
          </Button>
        }
      />
      <OrderEntry session={session} sessionId={sessionId} />
    </div>
  );
}
