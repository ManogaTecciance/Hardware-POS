'use client';

import { useSearchParams } from 'next/navigation';

import { PageHeader } from '@/components/page-header';
import { PosDineInWorkspace } from '@/components/pos/pos-dine-in-workspace';
import { type PosMode } from '@/components/pos/pos-mode-selector';
import { PosRetailCheckout } from '@/components/pos/pos-retail-checkout';
import { PosTakeawayWorkspace } from '@/components/pos/pos-takeaway-workspace';
import { PosThirdPartyWorkspace } from '@/components/pos/pos-third-party-workspace';
import { Card, CardContent } from '@/components/ui/card';
import { useAuth } from '@/lib/auth';
import { useEffectiveProfile } from '@/lib/platform-profile';

/**
 * POS route — dispatches on the tenant's business type.
 *
 * Retail (Tile Shop / Hardware / Retail) → existing `PosRetailCheckout`
 * with catalog, cart and discount flow. Untouched by this slice.
 *
 * Restaurant / Cafe / Bakery → the new POS workspace with mode selector
 * (Dine In, Takeaway, 3rd Party). This slice ships Takeaway; Dine-In +
 * 3rd Party ship in Slice C.
 *
 * Unresolved profile falls back to the retail POS, matching the D31 rule
 * ("unresolved is its own state — never guess Restaurant") that
 * `dashboard/page.tsx` already applies.
 */
export default function PosPage() {
  const { session } = useAuth();
  const { profile } = useEffectiveProfile();
  const params = useSearchParams();

  if (!session) return null;

  const isRestaurantProfile =
    profile?.businessType === 'RESTAURANT' ||
    profile?.businessType === 'CAFE' ||
    profile?.businessType === 'BAKERY';

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
  const mode: PosMode =
    raw === 'dine-in'
      ? 'DINE_IN'
      : raw === 'third-party'
        ? 'THIRD_PARTY'
        : 'TAKEAWAY';

  if (mode === 'TAKEAWAY') {
    return <PosTakeawayWorkspace session={session} branchId={session.branchId} />;
  }
  if (mode === 'DINE_IN') {
    const sessionId = params.get('sessionId');
    return (
      <PosDineInWorkspace
        session={session}
        branchId={session.branchId}
        sessionId={sessionId}
      />
    );
  }
  // THIRD_PARTY
  const externalOrderId = params.get('externalOrderId');
  return (
    <PosThirdPartyWorkspace
      session={session}
      branchId={session.branchId}
      externalOrderId={externalOrderId}
    />
  );
}
