'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import * as React from 'react';

import { PageHeader } from '@/components/page-header';
import { PosCounterWorkspace } from '@/components/pos/pos-counter-workspace';
import { PosDineInWorkspace } from '@/components/pos/pos-dine-in-workspace';
import { type PosMode } from '@/components/pos/pos-mode-selector';
import { PosRetailCheckout } from '@/components/pos/pos-retail-checkout';
import { PosThirdPartyWorkspace } from '@/components/pos/pos-third-party-workspace';
import { Card, CardContent } from '@/components/ui/card';
import { useAuth } from '@/lib/auth';
import { useEffectiveProfile } from '@/lib/platform-profile';

/**
 * POS route — dispatches on the tenant's business type.
 *
 * Retail (Tile Shop / Hardware / Retail) → existing `PosRetailCheckout`,
 * untouched.
 *
 * Restaurant / Cafe / Bakery → the counter POS workspace.
 *
 *   * `?mode=…` absent → the counter workspace opens the Order Type
 *     modal on mount (per Pilot Change 3 Section 1).
 *   * `?mode=takeaway` or `?mode=third-party` → the workspace opens
 *     straight into that mode.
 *   * `?mode=dine-in` → the waiter's table-service flow
 *     (`PosDineInWorkspace`): pick a table or an open session, then order
 *     entry. With `&sessionId=…` it opens that session directly.
 *
 *     2026-08-18 (PO): dine-in is a WAITER flow, not a counter one. It used
 *     to fall through to the counter workspace when no session was named —
 *     which assumed the guest was standing at the till paying immediately,
 *     the opposite of table service. Items now go to the kitchen as the
 *     waiter adds them and the bill is settled when they close the table.
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
  const sessionId = params.get('sessionId');
  const externalOrderId = params.get('externalOrderId');
  const mode: PosMode | null =
    raw === 'dine-in'
      ? 'DINE_IN'
      : raw === 'third-party'
        ? 'THIRD_PARTY'
        : raw === 'takeaway'
          ? 'TAKEAWAY'
          : null;

  // Deep-link exceptions that still route to the pre-existing screens.
  if (mode === 'DINE_IN') {
    return (
      <PosDineInWorkspace
        session={session}
        branchId={session.branchId}
        sessionId={sessionId}
      />
    );
  }
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
      onModeChange={(m) => {
        // Keep the URL in sync so bookmarks + back-button work. Empty
        // mode drops the ?mode= param — Order Type modal re-opens.
        const next = m
          ? `/pos?mode=${m.toLowerCase().replace('_', '-')}`
          : '/pos';
        router.replace(next);
      }}
    />
  );
}
