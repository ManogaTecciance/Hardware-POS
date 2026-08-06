'use client';

import { UpcomingFeature } from '@/components/upcoming-feature';

/**
 * Restaurant workspace shell (Slice 8.4). No domain model, no data, no writes —
 * see `upcoming-feature.tsx` for why the route exists before the feature does.
 */
export default function TakeawayPage() {
  return (
    <UpcomingFeature
      title="Takeaway"
      description="Counter and collection orders."
      capabilities={['Takeaway order capture', 'Collection scheduling', 'Customer notification', 'Counter payment and billing']}
    />
  );
}
