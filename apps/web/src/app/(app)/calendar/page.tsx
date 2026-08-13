'use client';

import * as React from 'react';

import { PageHeader } from '@/components/page-header';
import { ReservationCalendar } from '@/components/restaurant/calendar/reservation-calendar';
import { Card, CardContent } from '@/components/ui/card';
import { useAuth } from '@/lib/auth';

/**
 * Calendar page (D47).
 *
 * The reservation book: one service day as a chart of tables × timeslots,
 * with navigation to past and future days. Booking, seating and cancelling
 * happen inline; the Tables page stays the authority for the live floor.
 */
export default function CalendarPage() {
  const { session, hasPermission } = useAuth();
  if (!session) return null;

  if (!session.branchId) {
    return (
      <div className="space-y-6">
        <PageHeader title="Calendar" description="Table reservations by timeslot." />
        <Card>
          <CardContent className="py-16 text-center text-sm text-muted-foreground">
            This user has no active branch. Ask an administrator to grant branch access
            before opening the reservation calendar.
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Calendar"
        description={`${session.branchName} — reservations for the day, past and future.`}
      />
      <ReservationCalendar
        session={session}
        branchId={session.branchId}
        canCreate={hasPermission('reservation:create')}
        canManage={hasPermission('reservation:manage')}
      />
    </div>
  );
}
