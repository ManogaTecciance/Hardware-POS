'use client';

import { UpcomingFeature } from '@/components/upcoming-feature';

/**
 * Restaurant workspace shell (Slice 8.4). No domain model, no data, no writes —
 * see `upcoming-feature.tsx` for why the route exists before the feature does.
 */
export default function TablesPage() {
  return (
    <UpcomingFeature
      title="Tables"
      description="Dining areas, tables and table service."
      capabilities={['Dining areas and table layout', 'Opening and closing table sessions', 'Multiple order rounds per table', 'Splitting and merging bills']}
    />
  );
}
