'use client';

import * as React from 'react';

import { AdminDashboard } from '@/components/dashboard/admin-dashboard';
import { CashierDashboard } from '@/components/dashboard/cashier-dashboard';
import { RestaurantDashboard } from '@/components/dashboard/restaurant-dashboard';
import { useAuth } from '@/lib/auth';
import { resolveDashboardVariant } from '@/lib/dashboard/roles';
import { useEffectiveProfile } from '@/lib/platform-profile';

/**
 * Dashboard router.
 *
 * Two dispatches: first on the tenant's *business type* (so a Restaurant
 * tenant gets the operational service board rather than the retail sales
 * summary), then on the user's *role* (owner/admin sees full analytics,
 * cashier sees a leaner view). Restaurant does not further split by role in
 * this slice — waiter/cashier/kitchen-manager all use the same service
 * dashboard today; if that stops being right, extend the resolver rather
 * than branching in this file.
 *
 * The profile's unresolved state falls back to the retail shape rather than
 * guessing Restaurant — matching D31: unresolved is its own state.
 */
export default function DashboardPage() {
  const { session, hasPermission } = useAuth();
  const { profile } = useEffectiveProfile();

  if (!session) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center text-sm text-muted-foreground">
        Loading your dashboard…
      </div>
    );
  }

  // D56: a capability read, not a business-type comparison. The inline
  // predicate this replaced omitted HOTEL in every copy of itself — the
  // capability is resolved once, server-side, from the domain registry.
  const isRestaurantProfile = profile?.capabilities.fulfilment.kind === 'TABLE_SERVICE';
  if (isRestaurantProfile) {
    return <RestaurantDashboard session={session} />;
  }

  const variant = resolveDashboardVariant(session.user.role);
  return variant === 'cashier' ? (
    <CashierDashboard session={session} hasPermission={hasPermission} />
  ) : (
    <AdminDashboard session={session} hasPermission={hasPermission} />
  );
}
