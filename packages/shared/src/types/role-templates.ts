/**
 * Role templates — the roles a tenant is created with (Phase 1.5, D36/D37).
 *
 * ## What a template is
 *
 * A name, a stable key, and a set of permissions. Cloned into each tenant at
 * provisioning, after which the tenant owns its copy and may rename it. Nothing
 * reads a template at authorization time: the database rows are the authority,
 * and these are only what those rows are seeded from.
 *
 * ## Why the key exists separately from the name
 *
 * `Role` is keyed `@@unique([tenantId, name])` — on a display name an admin can
 * change. A built-in role identified by its display name stops being findable the
 * moment someone renames "Manager" to "Supervisor", and the code that looks it up
 * either creates a duplicate or silently grants nothing. `key` is the identifier;
 * `name` is presentation.
 *
 * ## Restaurant roles are data, not enum members
 *
 * `UserRole` stays at the five built-in platform roles. Waiter, Kitchen Staff and
 * the rest are *rows*, because adding them to a persisted enum would commit the
 * whole platform to a vocabulary before the features exist, and enum values cannot
 * be removed without a destructive migration.
 *
 * Their permissions are **reserved** ones (see `RESERVED_PERMISSIONS`): declared,
 * assignable, and enforced by nothing, because no restaurant operational feature
 * is implemented. Seeding a Waiter role does not make waiting tables possible; it
 * makes the role available to configure against features that arrive later.
 */
import { Permission, ROLE_PERMISSIONS, UserRole } from './authorization.js';

export interface RoleTemplate {
  /** Stable identifier. Never shown, never edited, unique per tenant. */
  key: string;
  /** Default display name. The tenant may change it. */
  name: string;
  description: string;
  /**
   * Built-in roles cannot be deleted by a tenant, and their `key` is referenced by
   * the `UserRole` compatibility path during the transition.
   */
  isBuiltIn: boolean;
  permissions: readonly Permission[];
}

/**
 * The five platform roles, mirroring `ROLE_PERMISSIONS` exactly.
 *
 * Derived from it rather than restated, so the two cannot disagree — a second
 * hand-maintained copy of a permission set is precisely the drift Slice 7.3 was
 * written to end. The parity spec still asserts the equality, because deriving it
 * here would not stop someone replacing the derivation with a literal later.
 */
export const BUILT_IN_ROLE_TEMPLATES: readonly RoleTemplate[] = [
  {
    key: UserRole.Owner,
    name: 'Owner',
    description: 'Full access to every feature the tenant has enabled.',
    isBuiltIn: true,
    permissions: ROLE_PERMISSIONS.OWNER,
  },
  {
    key: UserRole.Admin,
    name: 'Administrator',
    description: 'Full access. Intended for staff who administer the system.',
    isBuiltIn: true,
    permissions: ROLE_PERMISSIONS.ADMIN,
  },
  {
    key: UserRole.Manager,
    name: 'Manager',
    description: 'Runs the shop floor: sales, returns, quotations, approvals.',
    isBuiltIn: true,
    permissions: ROLE_PERMISSIONS.MANAGER,
  },
  {
    key: UserRole.Accountant,
    name: 'Accountant',
    description: 'Read-only across sales, returns and accounting integration.',
    isBuiltIn: true,
    permissions: ROLE_PERMISSIONS.ACCOUNTANT,
  },
  {
    key: UserRole.Cashier,
    name: 'Cashier',
    description: 'Takes sales and payments at the till.',
    isBuiltIn: true,
    permissions: ROLE_PERMISSIONS.CASHIER,
  },
];

/**
 * Restaurant operational roles.
 *
 * Seeded only for tenants whose business profile is food-service. Every
 * permission below is reserved — **none of these roles can currently do
 * anything**, because none of the features exists. They are here so that the
 * permission model, the role UI and the assignment paths can be built and tested
 * against realistic data before Restaurant Phase 2 delivers the features.
 *
 * `PRODUCT_READ` and `SALE_READ` are the exceptions: those are active permissions
 * on shared-core routes, and a restaurant manager genuinely needs them today.
 */
export const RESTAURANT_ROLE_TEMPLATES: readonly RoleTemplate[] = [
  {
    key: 'RESTAURANT_MANAGER',
    name: 'Restaurant Manager',
    description: 'Runs service: tables, orders, bills and staff on shift.',
    isBuiltIn: false,
    permissions: [
      Permission.SALE_READ,
      Permission.PRODUCT_READ,
      Permission.CUSTOMER_READ,
      Permission.REPORT_READ,
      Permission.PLATFORM_PROFILE_READ,
      Permission.TABLE_VIEW,
      Permission.TABLE_OPEN,
      Permission.TABLE_TRANSFER,
      Permission.TABLE_MERGE,
      Permission.TABLE_CLOSE,
      Permission.ORDER_CREATE,
      Permission.ORDER_EDIT_DRAFT,
      Permission.ORDER_SEND_TO_KITCHEN,
      Permission.ORDER_VOID_SENT,
      Permission.KOT_VIEW,
      Permission.KOT_PRINT,
      Permission.TAKEAWAY_VIEW,
      Permission.TAKEAWAY_CREATE,
      Permission.BILL_VIEW,
      Permission.BILL_SPLIT,
      Permission.PAYMENT_COLLECT,
      // Phase 2A: restaurant managers configure their own branch and stations.
      Permission.RESTAURANT_CONFIG_MANAGE,
      Permission.KITCHEN_STATION_MANAGE,
      // D47: the reservation book.
      Permission.RESERVATION_VIEW,
      Permission.RESERVATION_CREATE,
      Permission.RESERVATION_MANAGE,
      // D49: joining tables is a shift decision.
      Permission.OPEN_TABLE_MANAGE,
    ],
  },
  {
    key: 'WAITER',
    name: 'Waiter',
    description: 'Opens tables, takes orders, sends them to the kitchen.',
    isBuiltIn: false,
    permissions: [
      // Navigation is derived from the tenant's enabled modules, so a role that
      // cannot read the platform profile renders an EMPTY rail — not a reduced
      // one. Every other floor-facing template already carries this.
      Permission.PLATFORM_PROFILE_READ,
      // The POS and Tables rail entries are gated on SALE_CREATE, and closing a
      // table is what creates the Sale — a waiter holding TABLE_CLOSE without
      // it could reach neither screen they spend the shift on. Harmless
      // otherwise: the retail POS route is behind the RETAIL_POS module, which
      // a food-service tenant does not have.
      Permission.SALE_CREATE,
      Permission.PRODUCT_READ,
      Permission.CUSTOMER_READ,
      Permission.TABLE_VIEW,
      Permission.TABLE_OPEN,
      Permission.TABLE_CLOSE,
      Permission.ORDER_CREATE,
      Permission.ORDER_EDIT_DRAFT,
      Permission.ORDER_SEND_TO_KITCHEN,
      Permission.BILL_VIEW,
      // D47: waiters take and manage bookings at the host stand.
      Permission.RESERVATION_VIEW,
      Permission.RESERVATION_CREATE,
      Permission.RESERVATION_MANAGE,
      // D49: joining tables is a shift decision.
      Permission.OPEN_TABLE_MANAGE,
      // Deliberately absent: ORDER_VOID_SENT and TABLE_TRANSFER/MERGE. Voiding an
      // order the kitchen has already started, and moving a table's bill, are the
      // two places where a waiter's mistake becomes someone else's loss — they
      // belong to whoever is accountable for the shift.
      //
      // Also deliberately absent: KOT_VIEW. It is the permission the Kitchen
      // rail entry is gated on, and a waiter has no business on the kitchen
      // display — they send orders to it, they do not work it. Sending is
      // ORDER_SEND_TO_KITCHEN, which they do hold. Likewise SALE_READ and
      // REPORT_READ are absent, so Sales and Reports never appear for them,
      // and PRODUCT_MANAGE / CATEGORY_MANAGE are absent so the catalogue and
      // promotions are read-only.
    ],
  },
  {
    key: 'RESTAURANT_CASHIER',
    name: 'Restaurant Cashier',
    description: 'Settles bills and collects payment.',
    isBuiltIn: false,
    permissions: [
      Permission.SALE_READ,
      Permission.PRODUCT_READ,
      Permission.CUSTOMER_READ,
      Permission.CUSTOMER_MANAGE,
      Permission.TABLE_VIEW,
      Permission.TAKEAWAY_VIEW,
      Permission.BILL_VIEW,
      Permission.BILL_SPLIT,
      Permission.PAYMENT_COLLECT,
      // D47: the cashier often doubles as the host answering the phone.
      Permission.RESERVATION_VIEW,
      Permission.RESERVATION_CREATE,
      Permission.RESERVATION_MANAGE,
      // D49: joining tables is a shift decision.
      Permission.OPEN_TABLE_MANAGE,
    ],
  },
  {
    key: 'KITCHEN_MANAGER',
    name: 'Kitchen Manager',
    description: 'Runs the kitchen: ticket queue, station status, reprints.',
    isBuiltIn: false,
    permissions: [
      Permission.PRODUCT_READ,
      Permission.KOT_VIEW,
      Permission.KOT_PRINT,
      Permission.KITCHEN_STATUS_UPDATE,
      Permission.ORDER_VOID_SENT,
      Permission.TAKEAWAY_VIEW,
      // Phase 2A: kitchen managers configure their own stations.
      Permission.KITCHEN_STATION_MANAGE,
    ],
  },
  {
    key: 'KITCHEN_STAFF',
    name: 'Kitchen Staff',
    description: 'Sees the ticket queue and marks items as they are prepared.',
    isBuiltIn: false,
    permissions: [Permission.KOT_VIEW, Permission.KITCHEN_STATUS_UPDATE],
  },
  {
    key: 'BAR_STAFF',
    name: 'Bar Staff',
    description: 'Sees drink tickets and marks them as they are poured.',
    isBuiltIn: false,
    // Identical to kitchen staff today. Station routing is what will make them
    // different, and that is Phase 6 — so the roles are separate now rather than
    // one role that has to be split later, when it already has users attached.
    permissions: [Permission.KOT_VIEW, Permission.KITCHEN_STATUS_UPDATE],
  },
];

/** Every template, for iteration in seeds and tests. */
export const ALL_ROLE_TEMPLATES: readonly RoleTemplate[] = [
  ...BUILT_IN_ROLE_TEMPLATES,
  ...RESTAURANT_ROLE_TEMPLATES,
];

/** Templates a tenant of this business type is provisioned with. */
export function roleTemplatesForBusinessType(businessType: string): readonly RoleTemplate[] {
  // D55: HOTEL joins the food-service set — its template mirrors restaurant,
  // so it gets the same waiter / kitchen / bar roles.
  const foodService =
    businessType === 'RESTAURANT' ||
    businessType === 'CAFE' ||
    businessType === 'BAKERY' ||
    businessType === 'HOTEL';
  return foodService
    ? [...BUILT_IN_ROLE_TEMPLATES, ...RESTAURANT_ROLE_TEMPLATES]
    : BUILT_IN_ROLE_TEMPLATES;
}
