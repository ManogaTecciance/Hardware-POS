'use client';

import { useRouter, useSearchParams } from 'next/navigation';

import { PageHeader } from '@/components/page-header';
import { PosModeSelector, type PosMode } from '@/components/pos/pos-mode-selector';
import { PosRetailCheckout } from '@/components/pos/pos-retail-checkout';
import { PosTakeawayWorkspace } from '@/components/pos/pos-takeaway-workspace';
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
  const router = useRouter();
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

  // Dine In + 3rd Party arrive in Slice C. Show a waypoint that keeps the
  // mode selector visible so the operator can flip back to Takeaway
  // without navigating away and losing the workspace scroll position.
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <PageHeader title="POS" description={`${session.branchName} · Counter 1`} />
        <PosModeSelector
          value={mode}
          onChange={(next) =>
            router.push(`/pos?mode=${next.toLowerCase().replace('_', '-')}`)
          }
        />
      </div>
      <Card>
        <CardContent className="space-y-2 py-16 text-center">
          <p className="text-sm font-medium">
            {mode === 'DINE_IN' ? 'Dine In' : '3rd Party'} lands in the next slice.
          </p>
          <p className="text-xs text-muted-foreground">
            For now use{' '}
            <button
              type="button"
              className="text-primary underline"
              onClick={() => router.push('/pos?mode=takeaway')}
            >
              Takeaway
            </button>{' '}
            or the existing{' '}
            <button
              type="button"
              className="text-primary underline"
              onClick={() => router.push('/tables')}
            >
              Tables
            </button>{' '}
            floor.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
