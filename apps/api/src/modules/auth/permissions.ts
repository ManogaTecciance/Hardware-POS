import { UserRole } from '@hardware-pos/database';

/**
 * Fine-grained permissions. Each role maps to a set of these; guards check the
 * authenticated user's role against the permission a route requires.
 *
 * The DB Role/Permission tables remain available for custom per-tenant roles;
 * this code-level map covers the built-in roles for fast, dependency-free checks.
 */
export enum Permission {
  SALE_CREATE = 'sale:create',
  SALE_READ = 'sale:read',
  PAYMENT_CREATE = 'payment:create',
  DISCOUNT_APPROVE = 'discount:approve',
  RETURN_CREATE = 'return:create',
  RETURN_READ = 'return:read',
  RETURN_APPROVE = 'return:approve',
  QUOTATION_CREATE = 'quotation:create',
  QUOTATION_READ = 'quotation:read',
  QUOTATION_APPROVE = 'quotation:approve',
  QUOTATION_CONVERT = 'quotation:convert',
  QUOTATION_SHARE = 'quotation:share',
  QUOTATION_CANCEL = 'quotation:cancel',
  CATEGORY_MANAGE = 'category:manage',
  PRODUCT_READ = 'product:read',
  PRODUCT_MANAGE = 'product:manage',
  CUSTOMER_READ = 'customer:read',
  CUSTOMER_MANAGE = 'customer:manage',
  SUPPLIER_READ = 'supplier:read',
  SUPPLIER_MANAGE = 'supplier:manage',
  SUPPLIER_DELETE = 'supplier:delete',
  SUPPLIER_QB_MAP = 'supplier:qb:map',
  SYNC_READ = 'sync:read',
  QUICKBOOKS_READ = 'quickbooks:read',
  QUICKBOOKS_MANAGE = 'quickbooks:manage',
  SETTINGS_MANAGE = 'settings:manage',
  USER_MANAGE = 'user:manage',
  REPORT_READ = 'report:read',
  /** Read the tenant's effective platform profile and module set. */
  PLATFORM_PROFILE_READ = 'platform:profile:read',
  /** Change the tenant's business type, inventory/accounting mode, or modules. */
  PLATFORM_PROFILE_MANAGE = 'platform:profile:manage',
}

const ALL_PERMISSIONS: Permission[] = Object.values(Permission);

/** Role → permissions. Owner/Admin manage everything. */
export const ROLE_PERMISSIONS: Record<UserRole, Permission[]> = {
  OWNER: ALL_PERMISSIONS,
  ADMIN: ALL_PERMISSIONS,
  MANAGER: [
    Permission.SALE_CREATE,
    Permission.SALE_READ,
    Permission.PAYMENT_CREATE,
    Permission.DISCOUNT_APPROVE,
    Permission.RETURN_CREATE,
    Permission.RETURN_READ,
    Permission.RETURN_APPROVE,
    Permission.QUOTATION_CREATE,
    Permission.QUOTATION_READ,
    Permission.QUOTATION_APPROVE,
    Permission.QUOTATION_CONVERT,
    Permission.QUOTATION_SHARE,
    Permission.QUOTATION_CANCEL,
    Permission.CATEGORY_MANAGE,
    Permission.PRODUCT_READ,
    Permission.PRODUCT_MANAGE,
    Permission.CUSTOMER_READ,
    Permission.CUSTOMER_MANAGE,
    // Purchasing Officer / Manager: manage vendors and map QuickBooks, but
    // cannot permanently delete.
    Permission.SUPPLIER_READ,
    Permission.SUPPLIER_MANAGE,
    Permission.SUPPLIER_QB_MAP,
    Permission.REPORT_READ,
    // Read-only: a manager sees which modules the tenant runs, but changing the
    // business type or accounting provider is an owner/admin decision.
    Permission.PLATFORM_PROFILE_READ,
  ],
  CASHIER: [
    Permission.SALE_CREATE,
    Permission.SALE_READ,
    Permission.PAYMENT_CREATE,
    Permission.RETURN_CREATE,
    Permission.RETURN_READ,
    Permission.QUOTATION_CREATE,
    Permission.QUOTATION_READ,
    Permission.QUOTATION_CONVERT,
    Permission.QUOTATION_SHARE,
    Permission.PRODUCT_READ,
    Permission.CUSTOMER_READ,
    Permission.CUSTOMER_MANAGE,
    // Read-only. Navigation is driven by the tenant's enabled modules, so a
    // cashier that could not read them could not render a POS screen at all.
    Permission.PLATFORM_PROFILE_READ,
  ],
  ACCOUNTANT: [
    Permission.SYNC_READ,
    Permission.QUICKBOOKS_READ,
    Permission.SALE_READ,
    Permission.RETURN_READ,
    Permission.QUOTATION_READ,
    Permission.PRODUCT_READ,
    Permission.CUSTOMER_READ,
    // Accountant: read vendors and their QuickBooks mapping; no editing.
    Permission.SUPPLIER_READ,
    Permission.SUPPLIER_QB_MAP,
    Permission.REPORT_READ,
    // Read-only: an accountant needs to know which accounting provider the tenant
    // is on, but must not be able to switch it.
    Permission.PLATFORM_PROFILE_READ,
  ],
};

export function roleHasPermission(role: UserRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
}
