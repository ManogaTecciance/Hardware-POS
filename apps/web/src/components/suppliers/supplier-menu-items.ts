import { Ban, Link2, Pencil, PlayCircle, Eye, PauseCircle, Trash2 } from 'lucide-react';

import type { MenuItem } from '@/components/ui/menu';
import type { SupplierAccess } from '@/lib/suppliers/access';
import type { SupplierAction } from './use-supplier-action-dialogs';
import type { SupplierQbStatus, SupplierStatus } from '@/lib/suppliers/types';

interface MenuTarget {
  id: string;
  name: string;
  status: SupplierStatus;
  qbStatus: SupplierQbStatus;
}

/**
 * Build the row / profile "More" menu for a supplier. View/Edit are links;
 * lifecycle + destructive actions dispatch through the shared action dialogs.
 * Destructive Delete is never a bare row button — it lives here, gated by
 * permission, and the dialog re-checks that the record is unused.
 */
export function buildSupplierMenuItems(
  target: MenuTarget,
  access: SupplierAccess,
  request: (action: SupplierAction, t: { id: string; name: string }) => void,
): MenuItem[] {
  const t = { id: target.id, name: target.name };
  const items: MenuItem[] = [{ label: 'View supplier', icon: Eye, href: `/suppliers/${target.id}` }];

  if (access.canManage) {
    items.push({ label: 'Edit supplier', icon: Pencil, href: `/suppliers/${target.id}/edit` });
  }
  if (access.canMapQuickBooks) {
    items.push({
      label: target.qbStatus === 'NOT_CONNECTED' ? 'Map to QuickBooks' : 'QuickBooks mapping',
      icon: Link2,
      onSelect: () => request('map-qb', t),
    });
  }

  if (access.canManage) {
    if (target.status === 'INACTIVE' || target.status === 'BLOCKED') {
      items.push({ label: 'Reactivate', icon: PlayCircle, onSelect: () => request('reactivate', t), separatorBefore: true });
    }
    if (target.status === 'ACTIVE' || target.status === 'DRAFT') {
      items.push({ label: 'Deactivate', icon: PauseCircle, onSelect: () => request('deactivate', t), separatorBefore: true });
    }
    if (target.status === 'ACTIVE' || target.status === 'INACTIVE') {
      items.push({ label: 'Block', icon: Ban, onSelect: () => request('block', t) });
    }
  }

  if (access.canDelete) {
    items.push({
      label: 'Delete permanently',
      icon: Trash2,
      danger: true,
      separatorBefore: true,
      onSelect: () => request('delete', t),
    });
  }

  return items;
}
