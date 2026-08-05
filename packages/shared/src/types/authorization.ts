/**
 * The canonical role and permission vocabulary (Slice 7.3, 7.4).
 *
 * ## Why this moved here
 *
 * Before Slice 7 the same vocabulary existed three times: a TypeScript `enum` in
 * `apps/api/src/modules/auth/permissions.ts`, a `const` object in
 * `apps/web/src/lib/permissions.ts`, and the `UserRole` enum in the Prisma schema.
 * They had already drifted, in both directions and silently:
 *
 *  • The web copy was missing `PLATFORM_PROFILE_READ` and
 *    `PLATFORM_PROFILE_MANAGE`, added to the API in Slice 4. Every client-side
 *    check for them was therefore a compile error waiting to happen, and the
 *    navigation work in Slice 8 would have been built on an incomplete list.
 *  • `UserRole` here listed only `Cashier`, `Manager` and `Admin` — `OWNER` and
 *    `ACCOUNTANT` were absent, despite being real, persisted, seeded roles that
 *    the API grants permissions to.
 *
 * Neither was caught by a test, because no test compared the copies. Both are now
 * defined once, here, and the copies re-export. Parity specs on both sides compare
 * this file against the Prisma enum.
 *
 * ## Why `const` objects rather than `enum`
 *
 * This package must stay importable from the browser, so it cannot depend on
 * `@hardware-pos/database` (which pulls in the Prisma client) and avoids
 * TypeScript `enum` runtime emit. Each declaration exports a value and a
 * same-named union type, which supports every use the `enum` supported:
 * `Permission.SALE_CREATE` as a value, `Permission` as a type, and
 * `Object.values(Permission)` at runtime.
 *
 * ## What this file is NOT
 *
 * It is not an authority on what a *tenant* has enabled — that is `ModuleKey` and
 * the effective business profile. Roles say what a user may do; modules say what
 * the tenant runs. Both must hold, and they are enforced by separate guards.
 */

/**
 * Staff roles.
 *
 * Values are the persisted strings in `User.role` and must match the Prisma
 * `UserRole` enum exactly — `authorization.parity.spec.ts` proves it. Changing a
 * value here without a migration would orphan every existing row, so these are
 * append-only in practice.
 */
export const UserRole = {
  Cashier: 'CASHIER',
  Manager: 'MANAGER',
  Admin: 'ADMIN',
  Owner: 'OWNER',
  Accountant: 'ACCOUNTANT',
} as const;
export type UserRole = (typeof UserRole)[keyof typeof UserRole];

/** Every role value, for exhaustive iteration in guards and tests. */
export const ALL_USER_ROLES: readonly UserRole[] = Object.values(UserRole);

/**
 * Fine-grained permissions.
 *
 * The string values are a wire and storage contract: they appear in the
 * `Permission.key` column for custom per-tenant roles, and in `GET /auth/me`
 * responses the browser holds. Renaming one silently is a breaking change, so
 * values are treated as immutable and only added to.
 */
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
  /** Read the tenant's effective platform profile and module set. */
  PLATFORM_PROFILE_READ: 'platform:profile:read',
  /** Change the tenant's business type, inventory/accounting mode, or modules. */
  PLATFORM_PROFILE_MANAGE: 'platform:profile:manage',
} as const;
export type Permission = (typeof Permission)[keyof typeof Permission];

/** Every permission value. Owner and Admin hold exactly this set. */
export const ALL_PERMISSIONS: readonly Permission[] = Object.values(Permission);

/**
 * Role → permissions, for the five built-in roles.
 *
 * The `Record<UserRole, …>` key type is what makes a new role a **compile error**
 * here until someone decides what it may do. That is deliberate: the failure mode
 * this replaces was a role existing in the database with no entry in this map,
 * silently resolving to `undefined` and therefore to no permissions at all — which
 * looks like a permissions bug rather than a missing decision.
 *
 * Restaurant module permissions will be added to {@link Permission} and granted
 * here. They need no second authority: a Restaurant tenant is distinguished by its
 * *enabled modules*, not by a parallel permission system, so `MENU_MANAGE` will sit
 * beside `PRODUCT_MANAGE` and be gated at the route by `@RequireModule`.
 */
export const ROLE_PERMISSIONS: Record<UserRole, readonly Permission[]> = {
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

/** Does a built-in role hold this permission? */
export function roleHasPermission(role: UserRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
}
