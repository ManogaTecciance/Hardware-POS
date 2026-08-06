'use client';

import { UpcomingFeature } from '@/components/upcoming-feature';

/**
 * Restaurant workspace shell (Slice 8.4). No domain model, no data, no writes —
 * see `upcoming-feature.tsx` for why the route exists before the feature does.
 */
export default function KitchenPage() {
  return (
    <UpcomingFeature
      title="Kitchen"
      description="Kitchen tickets and preparation status."
      capabilities={['Kitchen order tickets (KOT)', 'Preparation status per item', 'Station routing and printing', 'Course timing']}
    />
  );
}
