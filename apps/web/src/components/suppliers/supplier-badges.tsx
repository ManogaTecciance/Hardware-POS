import {
  AlertTriangle,
  Ban,
  Check,
  CircleCheck,
  Clock,
  Minus,
  PauseCircle,
  PencilLine,
  Star,
  type LucideIcon,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import {
  QB_STATUS_LABELS,
  SUPPLIER_STATUS_LABELS,
  qbBadgeVariant,
  statusBadgeVariant,
  type SupplierQbStatus,
  type SupplierStatus,
} from '@/lib/suppliers/types';

const STATUS_ICON: Record<SupplierStatus, LucideIcon> = {
  ACTIVE: CircleCheck,
  INACTIVE: PauseCircle,
  BLOCKED: Ban,
  DRAFT: PencilLine,
};

/** Lifecycle status — conveyed by icon + text, never colour alone (WCAG 1.4.1). */
export function SupplierStatusBadge({ status }: { status: SupplierStatus }) {
  const Icon = STATUS_ICON[status];
  return (
    <Badge variant={statusBadgeVariant(status)}>
      <Icon className="h-3.5 w-3.5" aria-hidden />
      {SUPPLIER_STATUS_LABELS[status]}
    </Badge>
  );
}

const QB_ICON: Record<SupplierQbStatus, LucideIcon> = {
  CONNECTED: Check,
  WAITING: Clock,
  ATTENTION: AlertTriangle,
  NOT_CONNECTED: Minus,
};

export function SupplierQuickBooksBadge({ status }: { status: SupplierQbStatus }) {
  const Icon = QB_ICON[status];
  return (
    <Badge variant={qbBadgeVariant(status)}>
      <Icon className="h-3.5 w-3.5" aria-hidden />
      QuickBooks: {QB_STATUS_LABELS[status]}
    </Badge>
  );
}

export function PreferredBadge({ className }: { className?: string }) {
  return (
    <Badge variant="primary" className={className}>
      <Star className="h-3.5 w-3.5 fill-current" aria-hidden />
      Preferred
    </Badge>
  );
}
