'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import * as React from 'react';

import { PageHeader } from '@/components/page-header';
import { PosCounterWorkspace } from '@/components/pos/pos-counter-workspace';
import { type PosMode } from '@/components/pos/pos-mode-selector';
import { PosRetailCheckout } from '@/components/pos/pos-retail-checkout';
import { PosThirdPartyWorkspace } from '@/components/pos/pos-third-party-workspace';
import { Card, CardContent } from '@/components/ui/card';
import { useAuth } from '@/lib/auth';
import { useEffectiveProfile } from '@/lib/platform-profile';

/**
 * POS route — dispatches on the tenant's business type.
 *
 * Retail (Hardware / Retail) → existing `PosRetailCheckout`,
 * untouched.
 *
 * Restaurant / Cafe / Bakery → the counter POS workspace.
 *
 *   * `?mode=…` absent → the counter workspace opens the Order Type
 *     modal on mount (per Pilot Change 3 Section 1).
 *   * `?mode=takeaway` or `?mode=third-party` → the workspace opens
 *     straight into that mode.
 *   * `?mode=dine-in` → the SAME counter workspace, with a table-session
 *     block above the menu (D69). Composition is identical to takeaway;
 *     only the tail differs — Confirm & send posts a round to the table
 *     instead of opening customer → payment → completion.
 *
 *     2026-08-18 (PO): dine-in is a WAITER flow, not a counter one — items
 *     go to the kitchen as the waiter adds them, and the bill is raised when
 *     they close the table. 2026-08-21 (PO): that flow belongs on the
 *     ordinary POS screen rather than a separate one, so the fork this
 *     comment used to describe (`PosDineInWorkspace` → `OrderEntry`) is
 *     gone.
 *   * `?mode=dine-in&sessionId=…` → the same workspace BOUND to that open
 *     table session: no picker, the table named in the header, and the
 *     floor one tap away (D150). This is where the floor plan's "View
 *     order" now lands; `/tables/session/[id]` redirects here, and
 *     `OrderEntry` — the photo-less menu grid it used to mount — is gone.
 *   * `?mode=third-party&externalOrderId=…` → still routes to the
 *     `PosThirdPartyWorkspace` platform inspector for accepting inbound
 *     external orders. New Delivery-counter orders (composed here) use
 *     the counter workspace instead.
 *
 * Unresolved profile falls back to retail POS (D31).
 */
export default function PosPage() {
  const { session } = useAuth();
  const { profile } = useEffectiveProfile();
  const router = useRouter();
  const params = useSearchParams();

  if (!session) return null;

  // D56: a capability read, not a business-type comparison. The inline
  // predicate this replaced omitted HOTEL in every copy of itself — the
  // capability is resolved once, server-side, from the domain registry.
  const isRestaurantProfile = profile?.capabilities.fulfilment.kind === 'TABLE_SERVICE';

  if (!isRestaurantProfile) {
    return <PosRetailCheckout />;
  }

  if (!session.branchId) {
    return (
      <div className="space-y-6">
        <PageHeader title="POS" description="Fast order composition." />
        <Card>
          <CardContent className="py-16 text-center text-sm text-muted-foreground">
            This user has no active branch. Ask an administrator to grant branch access
            before opening the POS.
          </CardContent>
        </Card>
      </div>
    );
  }

  const raw = params.get('mode');
  const externalOrderId = params.get('externalOrderId');
  /*
   * D150 — the open table session this POS is taking orders onto. Written by
   * the floor plan's "View order" and the orders queue's "Open in POS"; it was
   * read by neither end before, so the queue's link had been dropping a cashier
   * into the table picker since the day it shipped.
   */
  const linkedSessionId = params.get('sessionId');
  const mode: PosMode | null =
    raw === 'dine-in'
      ? 'DINE_IN'
      : raw === 'third-party'
        ? 'THIRD_PARTY'
        : raw === 'takeaway'
          ? 'TAKEAWAY'
          : null;

  // Deep-link exception that still routes to a pre-existing screen.
  if (mode === 'THIRD_PARTY' && externalOrderId) {
    return (
      <PosThirdPartyWorkspace
        session={session}
        branchId={session.branchId}
        externalOrderId={externalOrderId}
      />
    );
  }

  return (
    <PosCounterWorkspace
      session={session}
      branchId={session.branchId}
      initialMode={mode}
      linkedSessionId={linkedSessionId}
      onModeChange={(m) => {
        // Keep the URL in sync so bookmarks + back-button work. Empty
        // mode drops the ?mode= param — Order Type modal re-opens.
        /*
         * D150 — `sessionId` survives only while the mode is still dine-in. A
         * dine-in-only role arrives with no `?mode=` at all, so this replace
         * runs on mount for exactly the role the deep link is FOR; dropping
         * the id here would unbind the table one render after the floor
         * handed it over. Changing the order type drops it, because a
         * takeaway order has no table.
         */
        const keepSession = m === 'DINE_IN' && linkedSessionId;
        const next = m
          ? `/pos?mode=${m.toLowerCase().replace('_', '-')}${
              keepSession ? `&sessionId=${encodeURIComponent(linkedSessionId)}` : ''
            }`
          : '/pos';
        router.replace(next);
      }}
    />
  );
}
