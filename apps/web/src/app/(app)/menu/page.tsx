'use client';

import { UpcomingFeature } from '@/components/upcoming-feature';

/**
 * Restaurant workspace shell (Slice 8.4). No domain model, no data, no writes —
 * see `upcoming-feature.tsx` for why the route exists before the feature does.
 */
export default function MenuPage() {
  return (
    <UpcomingFeature
      title="Menu"
      description="Menu items, categories and modifiers for this restaurant."
      capabilities={['Menu categories and sections', 'Menu items with modifier groups', 'Availability and scheduling', 'Pricing per channel']}
    />
  );
}
