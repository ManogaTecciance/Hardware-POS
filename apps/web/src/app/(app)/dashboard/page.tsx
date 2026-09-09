'use client';

import { useRouter } from 'next/navigation';
import * as React from 'react';

import { AdminDashboard } from '@/components/dashboard/admin-dashboard';
import { CashierDashboard } from '@/components/dashboard/cashier-dashboard';
import { RestaurantDashboard } from '@/components/dashboard/restaurant-dashboard';
import { useAuth } from '@/lib/auth';
import { resolveDashboardVariant } from '@/lib/dashboard/roles';
import { redirectFor, resolveNavigation } from '@/lib/nav';
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
  const { profile, status } = useEffectiveProfile();
  const router = useRouter();

  /*
   * D142 — this route is where login, `/` and every "back to safety" link
   * send people, and it is no longer everybody's. Kitchen staff may not see
   * the floor, so the service dashboard is not on their rail; landing them on
   * a screen their own navigation does not list would leave them nowhere.
   *
   * The rail decides, not a role name: `redirectFor` answers `null` while the
   * profile is unresolved (D31 — unresolved is its own state, never a guess)
   * and `null` for anyone whose rail does offer this destination, so the
   * owner, the waiter and the till are untouched.
   */
  const elsewhere = redirectFor(
    resolveNavigation({
      businessType: profile?.businessType ?? null,
      enabledModules: profile?.enabledModules ?? null,
      hasPermission,
    }),
    '/dashboard',
  );
  React.useEffect(() => {
    if (elsewhere) router.replace(elsewhere);
  }, [elsewhere, router]);

  if (elsewhere) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center text-sm text-muted-foreground">
        Taking you to your workspace…
      </div>
    );
  }

  /*
   * Nothing is rendered until the profile has resolved.
   *
   * The dispatch below is on the BUSINESS TYPE, so rendering before the answer
   * arrives falls through to the retail branch and shows a restaurant tenant
   * the retail cashier dashboard — which then fires the retail dashboard's
   * requests. D31 already calls unresolved its own state; D142 makes it matter,
   * because whether this page belongs to the viewer at all is now decided from
   * the same profile, and a failed fetch would otherwise leave kitchen staff
   * parked on a screen that is neither theirs nor their workspace's.
   */
  if (!session || status === 'loading') {
    return (
      <div className="flex min-h-[40vh] items-center justify-center text-sm text-muted-foreground">
        Loading your dashboard…
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="flex min-h-[40vh] items-center justify-center text-sm text-muted-foreground">
        Could not load this workspace. Refresh to try again.
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
