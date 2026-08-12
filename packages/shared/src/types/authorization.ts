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

  // ── Reserved for restaurant operations (Phase 1.5) ───────────────────────
  //
  // These are declared so that restaurant role templates can be expressed as
  // real permission assignments rather than as free-form strings. **No route
  // enforces any of them today, and none of the features behind them exists.**
  // `reserved-permissions.spec.ts` asserts exactly that — a reserved key that
  // acquires a controller must be moved out of this block deliberately, which is
  // the moment someone has to say the feature is implemented.
  //
  // They are in the catalogue rather than beside it because the alternative is an
  // assignment referencing a key the catalogue does not know, and unknown keys
  // must fail closed. A key that is known-but-unused is inert; a key that is
  // unknown is a hole.
  TABLE_VIEW: 'table:view',
  TABLE_OPEN: 'table:open',
  TABLE_TRANSFER: 'table:transfer',
  TABLE_MERGE: 'table:merge',
  TABLE_CLOSE: 'table:close',
  ORDER_CREATE: 'order:create',
  ORDER_EDIT_DRAFT: 'order:edit:draft',
  ORDER_SEND_TO_KITCHEN: 'order:send-to-kitchen',
  ORDER_VOID_SENT: 'order:void:sent',
  KOT_VIEW: 'kot:view',
  KOT_PRINT: 'kot:print',
  KITCHEN_STATUS_UPDATE: 'kitchen:status:update',
  TAKEAWAY_VIEW: 'takeaway:view',
  TAKEAWAY_CREATE: 'takeaway:create',
  BILL_VIEW: 'bill:view',
  BILL_SPLIT: 'bill:split',
  PAYMENT_COLLECT: 'payment:collect',

  // ── Restaurant Phase 2A (active) ─────────────────────────────────────────
  //
  // Enforced now — Phase 2A ships the restaurant configuration and kitchen
  // station administration routes.
  /** Change the branch's restaurant configuration (service charge, hours, …). */
  RESTAURANT_CONFIG_MANAGE: 'restaurant:config:manage',
  /** Add, edit, archive kitchen stations on a branch. */
  KITCHEN_STATION_MANAGE: 'kitchen:station:manage',

  // ── D44 — Receive Stock (Purchase Receipt) ───────────────────────────────
  //
  // Separate from PRODUCT_MANAGE so a Cashier / Waiter with product-read
  // never sees the Receive Stock action and a Manager tasked with
  // receiving can be granted it without also getting product write access
  // if the tenant later splits the two roles. Held by OWNER, ADMIN,
  // MANAGER by default (see ROLE_PERMISSIONS below).
  /** Create an InventoryReceipt on a branch (Receive Stock). */
  INVENTORY_RECEIVE: 'inventory:receive',

  // ── Restaurant Pilot Change 1 — creator-owned floor management ───────────
  //
  // Six permissions that split "manage the floor" into create-anything and
  // edit-your-own / archive-your-own. Every mutation route requires BOTH the
  // matching permission AND `entity.createdByUserId === actor.id`; role alone
  // is never sufficient (that is what `_OWN` names — the row must belong to
  // the caller). Only the OWNER role template holds these by default; ADMIN
  // has them stripped from its otherwise-total set so that the "any other
  // user must not edit that entity" rule survives even for the highest role
  // short of OWNER.
  /** Create a Dining Area / Floor on a branch. */
  DINING_AREA_CREATE: 'dining-area:create',
  /** Edit a Dining Area the caller created. Ownership check is at the service. */
  DINING_AREA_EDIT_OWN: 'dining-area:edit:own',
  /** Archive a Dining Area the caller created (soft-delete via `isActive=false`). */
  DINING_AREA_ARCHIVE_OWN: 'dining-area:archive:own',
  /** Create a Restaurant Table on a Dining Area. */
  TABLE_CREATE: 'table:create',
  /** Edit a Restaurant Table the caller created. */
  TABLE_EDIT_OWN: 'table:edit:own',
  /** Archive a Restaurant Table the caller created. */
  TABLE_ARCHIVE_OWN: 'table:archive:own',
} as const;
export type Permission = (typeof Permission)[keyof typeof Permission];

/** Every permission value. Owner holds exactly this set; Admin holds all of it EXCEPT `CREATOR_OWNED_PERMISSIONS` — see below. */
export const ALL_PERMISSIONS: readonly Permission[] = Object.values(Permission);

/**
 * Permissions that only make sense when paired with a runtime ownership check
 * (the row's `createdByUserId` must equal the caller). Naming an OWNER-only
 * capability isn't enough on its own — a Restaurant tenant would then have any
 * OWNER able to overwrite another OWNER's floor. The service layer enforces the
 * `_OWN` half; ROLE_PERMISSIONS below refuses to grant these to any role but
 * OWNER, so a compromised ADMIN account cannot escalate itself into every
 * floor manager's row.
 *
 * Restaurant Pilot Change 1 (Aug 2026) — dining-area and restaurant-table
 * management moved from role-only to creator-scoped.
 */
export const CREATOR_OWNED_PERMISSIONS: readonly Permission[] = [
  Permission.DINING_AREA_CREATE,
  Permission.DINING_AREA_EDIT_OWN,
  Permission.DINING_AREA_ARCHIVE_OWN,
  Permission.TABLE_CREATE,
  Permission.TABLE_EDIT_OWN,
  Permission.TABLE_ARCHIVE_OWN,
];

/**
 * Permissions that exist in the vocabulary but govern nothing yet.
 *
 * Listing them is a claim that has to stay true: a spec walks every route's
 * metadata and fails if any of these appears on a controller. That turns
 * "reserved" from a comment into an enforced state, and stops a half-built
 * restaurant feature from arriving without anyone deciding it had.
 */
export const RESERVED_PERMISSIONS: readonly Permission[] = [
  // Phase 5 activated: TABLE_VIEW, TABLE_OPEN, TABLE_CLOSE, ORDER_CREATE,
  // ORDER_SEND_TO_KITCHEN, ORDER_VOID_SENT (see `table-sessions.controller`).
  // Phase 6 activated: KOT_VIEW, KOT_PRINT, KITCHEN_STATUS_UPDATE (see
  // `kitchen-tickets.controller`).
  // Phase 7 activated: TAKEAWAY_VIEW, TAKEAWAY_CREATE (see `takeaway.controller`).
  // Phase 8 activated: BILL_VIEW, BILL_SPLIT, PAYMENT_COLLECT (see
  // `billing.controller`).
  Permission.TABLE_TRANSFER,
  Permission.TABLE_MERGE,
  Permission.ORDER_EDIT_DRAFT,
];

/** Permissions that a route may actually enforce today. */
export const ACTIVE_PERMISSIONS: readonly Permission[] = ALL_PERMISSIONS.filter(
  (p) => !RESERVED_PERMISSIONS.includes(p),
);

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
  // ADMIN historically inherited ALL_PERMISSIONS. Restaurant Pilot Change 1
  // narrows that: the six CREATOR_OWNED_PERMISSIONS name capabilities that
  // must be paired with a per-row ownership check, and granting them at the
  // role level to a non-OWNER would let an ADMIN edit an OWNER's floor
  // whenever the service ownership check moved out of the way (or was ever
  // bypassed by mistake). ADMIN keeps every other permission unchanged.
  ADMIN: ALL_PERMISSIONS.filter((p) => !CREATOR_OWNED_PERMISSIONS.includes(p)),
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
    // D44 — Receive Stock is a Manager-level action (recording stock a
    // supplier delivered is a floor / purchasing responsibility).
    Permission.INVENTORY_RECEIVE,
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
