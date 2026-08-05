import { AlertTriangle, Package } from 'lucide-react';

import { SyncBadge } from '@/components/quickbooks/sync-badge';
import { Badge } from '@/components/ui/badge';
import type { ProductPresentation } from '@/lib/products/product-presentation';
import type { ProductSyncStatus } from '@/lib/products-api';

/**
 * The status badge for one product, in whichever mode the tenant is configured for.
 *
 * For a QuickBooks tenant this renders the **existing `SyncBadge`, untouched** —
 * same labels, same variants, same icons — so the Tile Shop screens and their
 * Playwright scenarios are unaffected. For every other mode it renders the
 * provider-neutral label the resolver supplies.
 *
 * Status is never carried by colour alone: each badge has a text label, and the
 * icon is a plain package mark rather than a warning, because a local product with
 * no QuickBooks item id is valid and must not look like a fault. Only a genuine
 * configuration problem gets the warning triangle.
 */
export function ProductStatusBadge({
  presentation,
  syncStatus,
}: {
  presentation: ProductPresentation;
  syncStatus: ProductSyncStatus;
}) {
  if (presentation.showSyncStatus) return <SyncBadge status={syncStatus} />;
  if (!presentation.label) return null;

  const Icon = presentation.badgeKind === 'warning' ? AlertTriangle : Package;
  return (
    <Badge variant={presentation.badgeKind}>
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      {presentation.label}
    </Badge>
  );
}
