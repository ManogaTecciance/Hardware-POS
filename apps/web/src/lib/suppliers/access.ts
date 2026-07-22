/**
 * Supplier Management — capability derivation.
 *
 * Turns the session's permission list into a single capability object so
 * components read `access.canManage` rather than repeating `hasPermission(...)`
 * checks. Pure and unit-tested; UI gating and (when the backend lands) server
 * guards share the same permission constants.
 */

import { Permission } from '@/lib/permissions';

export interface SupplierAccess {
  canView: boolean;
  canManage: boolean;
  canDelete: boolean;
  canViewBank: boolean;
  canViewFinancials: boolean;
  canMapQuickBooks: boolean;
}

export function deriveSupplierAccess(permissions: Permission[]): SupplierAccess {
  const has = (p: Permission) => permissions.includes(p);
  return {
    canView: has(Permission.SUPPLIER_READ),
    canManage: has(Permission.SUPPLIER_MANAGE),
    canDelete: has(Permission.SUPPLIER_DELETE),
    canViewBank: has(Permission.SUPPLIER_BANK_VIEW),
    canViewFinancials: has(Permission.SUPPLIER_FINANCIALS_READ),
    canMapQuickBooks: has(Permission.SUPPLIER_QB_MAP),
  };
}
