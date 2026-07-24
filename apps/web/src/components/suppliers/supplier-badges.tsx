import { AlertTriangle, Check, CircleCheck, Clock, Minus, PauseCircle, type LucideIcon } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { QB_STATUS_LABELS, qbBadgeVariant, type SupplierQbStatus } from '@/lib/suppliers/types';

const QB_ICON: Record<SupplierQbStatus, LucideIcon> = {
  CONNECTED: Check,
  WAITING: Clock,
  ATTENTION: AlertTriangle,
  NOT_CONNECTED: Minus,
};

/** QuickBooks mapping state — conveyed by icon + text, never colour alone. */
export function SupplierQuickBooksBadge({
  status,
  short,
}: {
  status: SupplierQbStatus;
  /** Omit the "QuickBooks:" prefix (table cells). */
  short?: boolean;
}) {
  const Icon = QB_ICON[status];
  return (
    <Badge variant={qbBadgeVariant(status)}>
      <Icon className="h-3.5 w-3.5" aria-hidden />
      {short ? QB_STATUS_LABELS[status] : `QuickBooks: ${QB_STATUS_LABELS[status]}`}
    </Badge>
  );
}

export function SupplierActiveBadge({ isActive }: { isActive: boolean }) {
  return isActive ? (
    <Badge variant="success">
      <CircleCheck className="h-3.5 w-3.5" aria-hidden />
      Active
    </Badge>
  ) : (
    <Badge variant="neutral">
      <PauseCircle className="h-3.5 w-3.5" aria-hidden />
      Inactive
    </Badge>
  );
}
