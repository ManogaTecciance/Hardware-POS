/**
 * Supplier (vendor) capability derivation. Turns the session's permission list
 * into a single capability object so components read `access.canManage` rather
 * than repeating `hasPermission(...)` checks.
 */

import { Permission } from '@/lib/permissions';

export interface SupplierAccess {
  canView: boolean;
  canManage: boolean;
  canDelete: boolean;
  canMapQuickBooks: boolean;
}

export function deriveSupplierAccess(permissions: Permission[]): SupplierAccess {
  const has = (p: Permission) => permissions.includes(p);
  return {
    canView: has(Permission.SUPPLIER_READ),
    canManage: has(Permission.SUPPLIER_MANAGE),
    canDelete: has(Permission.SUPPLIER_DELETE),
    canMapQuickBooks: has(Permission.SUPPLIER_QB_MAP),
  };
}
