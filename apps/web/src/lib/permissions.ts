/** Roles and permissions, mirrored from the API for client-side UI gating. */

export type UserRole = 'OWNER' | 'ADMIN' | 'MANAGER' | 'CASHIER' | 'ACCOUNTANT';

export const Permission = {
  SALE_CREATE: 'sale:create',
  SALE_READ: 'sale:read',
  PAYMENT_CREATE: 'payment:create',
  DISCOUNT_APPROVE: 'discount:approve',
  RETURN_CREATE: 'return:create',
  RETURN_READ: 'return:read',
  RETURN_APPROVE: 'return:approve',
  QUOTATION_CREATE: 'quotation:create',
  QUOTATION_READ: 'quotation:read',
  QUOTATION_APPROVE: 'quotation:approve',
  QUOTATION_CONVERT: 'quotation:convert',
  QUOTATION_SHARE: 'quotation:share',
  QUOTATION_CANCEL: 'quotation:cancel',
  CATEGORY_MANAGE: 'category:manage',
  PRODUCT_READ: 'product:read',
  PRODUCT_MANAGE: 'product:manage',
  CUSTOMER_READ: 'customer:read',
  CUSTOMER_MANAGE: 'customer:manage',
  SUPPLIER_READ: 'supplier:read',
  SUPPLIER_MANAGE: 'supplier:manage',
  SUPPLIER_DELETE: 'supplier:delete',
  SUPPLIER_QB_MAP: 'supplier:qb:map',
  SYNC_READ: 'sync:read',
  QUICKBOOKS_READ: 'quickbooks:read',
  QUICKBOOKS_MANAGE: 'quickbooks:manage',
  SETTINGS_MANAGE: 'settings:manage',
  USER_MANAGE: 'user:manage',
  REPORT_READ: 'report:read',
} as const;

export type Permission = (typeof Permission)[keyof typeof Permission];

const ALL: Permission[] = Object.values(Permission);

export const ROLE_PERMISSIONS: Record<UserRole, Permission[]> = {
  OWNER: ALL,
  ADMIN: ALL,
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
    // Purchasing Officer / Manager: full operational supplier access, may map
    // QuickBooks and view financial summaries, but cannot permanently delete or
    // view protected bank details.
    Permission.SUPPLIER_READ,
    Permission.SUPPLIER_MANAGE,
    Permission.SUPPLIER_QB_MAP,
    Permission.REPORT_READ,
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
  ],
  ACCOUNTANT: [
    Permission.SYNC_READ,
    Permission.QUICKBOOKS_READ,
    Permission.SALE_READ,
    Permission.RETURN_READ,
    Permission.QUOTATION_READ,
    Permission.PRODUCT_READ,
    Permission.CUSTOMER_READ,
    // Accountant: read suppliers, view financial summaries and QuickBooks
    // mapping; no operational editing, delete, or bank access.
    Permission.SUPPLIER_READ,
    Permission.SUPPLIER_QB_MAP,
    Permission.REPORT_READ,
  ],
};

export function permissionsForRole(role: UserRole): Permission[] {
  return ROLE_PERMISSIONS[role] ?? [];
}

/** Max manual discount (% of line) a role may apply without approval. null = unlimited. */
export const ROLE_DISCOUNT_LIMIT_PERCENT: Record<UserRole, number | null> = {
  OWNER: null,
  ADMIN: null,
  MANAGER: 15,
  CASHIER: 0,
  ACCOUNTANT: 0,
};

export function discountLimitFor(role: UserRole): number | null {
  return ROLE_DISCOUNT_LIMIT_PERCENT[role];
}

/** True when `limit` (null = unlimited) permits a discount of `percent`. */
export function withinDiscountLimit(limit: number | null, percent: number): boolean {
  return limit === null || percent <= limit + 1e-9;
}
