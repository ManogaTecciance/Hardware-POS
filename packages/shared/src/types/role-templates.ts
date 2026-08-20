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
 * ## Operational roles are data, not enum members
 *
 * `UserRole` stays at the five built-in platform roles. The Waiter, the
 * food-service Cashier and the Receptionist are *rows*, because adding them to
 * a persisted enum would commit the whole platform to a vocabulary before the
 * features exist, and enum values cannot be removed without a destructive
 * migration. (That is also why trimming the template catalogue on 2026-08-17
 * deleted template OBJECTS below but no enum value: the enum is persisted
 * data with production users on it; a template is only a seeding blueprint.)
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
 * Templates for the built-in platform roles that workspaces still SEED.
 *
 * Only Owner and Cashier remain (PO decision, 2026-08-17): the ADMIN,
 * MANAGER and ACCOUNTANT templates were removed outright with the rest of
 * the unstaffed catalogue — a blueprint no template list references is not
 * dormant, it is an invitation to reintroduce the sprawl. The `UserRole`
 * ENUM keeps all five values: it is a persisted database enum, existing
 * users sit on those values and resolve through `ROLE_PERMISSIONS` on the
 * legacy fallback, and existing tenants keep their already-seeded rows.
 * Removing a template stops NEW seeding; it rewrites no one's authority.
 *
 * Each surviving template derives its permissions from `ROLE_PERMISSIONS`
 * rather than restating them, so the two cannot disagree; the parity spec
 * still asserts the equality.
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
    key: UserRole.Cashier,
    name: 'Cashier',
    description: 'Takes sales and payments at the till.',
    isBuiltIn: true,
    permissions: ROLE_PERMISSIONS.CASHIER,
  },
];

/**
 * Food-service operational roles: the Waiter and the (restaurant) Cashier.
 *
 * The wider catalogue this section used to carry — Restaurant Manager,
 * Kitchen Manager, Bar Staff — was removed with the other unstaffed
 * templates (2026-08-17). Their permissions remain in the catalogue and any
 * rows already seeded from them remain in their tenants; only the blueprints
 * are gone. Kitchen Staff came BACK on 2026-08-20 (D68) — not as a
 * restoration of the old catalogue, but because withdrawing kitchen printing
 * created a job that did not exist before: somebody has to work the board.
 */
export const RESTAURANT_ROLE_TEMPLATES: readonly RoleTemplate[] = [
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
    /*
     * D68 — the kitchen board's own user. Kitchen tickets stopped printing:
     * the board IS the delivery, so somebody has to be looking at it and
     * saying when food is done. That job had no role — Phase 6 gave
     * KOT_VIEW to nobody a workspace actually seeds, which is why the board
     * only ever opened for an owner.
     */
    key: 'KITCHEN_STAFF',
    name: 'Kitchen staff',
    description: 'Works the kitchen board: sees incoming tickets and marks them done.',
    isBuiltIn: false,
    permissions: [
      // Without this the navigation rail renders EMPTY rather than reduced —
      // same reasoning as the waiter template.
      Permission.PLATFORM_PROFILE_READ,
      // The two that ARE the job.
      Permission.KOT_VIEW,
      Permission.KITCHEN_STATUS_UPDATE,
      // Deliberately absent: everything on the floor and everything with
      // money in it. No TABLE_*, no ORDER_*, no BILL_*, no SALE_*,
      // no PAYMENT_COLLECT, no reporting, no configuration. Kitchen staff
      // read what was ordered and report what is cooked; they neither take
      // an order nor settle one, and a role that could do both would put
      // the pass in a position to write off a table's bill.
    ],
  },
  {
    key: 'RESTAURANT_CASHIER',
    // Displayed as plain "Cashier": inside a food-service workspace the
    // qualifier is noise (PO request, 2026-08-17). The KEY keeps its
    // qualified form — it is the stable identifier, and the built-in retail
    // CASHIER key must stay distinct from it. No name collision is possible:
    // the food-service template list no longer includes the built-in Cashier.
    name: 'Cashier',
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
];

/**
 * Hotel operational roles.
 *
 * A hotel workspace is food service under another name today (Q7), so the
 * receptionist is the front desk of THAT product: the person who takes
 * bookings, seats guests, looks after guest records and settles bills at the
 * desk. Room-night permissions arrive with the STAY fulfilment provider and
 * will be added to this template, not to a new one.
 */
export const HOTEL_ROLE_TEMPLATES: readonly RoleTemplate[] = [
  {
    key: 'RECEPTIONIST',
    name: 'Receptionist',
    description: 'Front desk: bookings, guest records, check-in and bills.',
    isBuiltIn: false,
    permissions: [
      // Navigation derives from the platform profile — without this the rail
      // renders empty, same reasoning as the waiter template.
      Permission.PLATFORM_PROFILE_READ,
      Permission.PRODUCT_READ,
      Permission.SALE_READ,
      // Guest records are the front desk's data.
      Permission.CUSTOMER_READ,
      Permission.CUSTOMER_MANAGE,
      // Check-in, today, is seating a session on the floor plan.
      Permission.TABLE_VIEW,
      Permission.TABLE_OPEN,
      // The booking diary is the core of the job.
      Permission.RESERVATION_VIEW,
      Permission.RESERVATION_CREATE,
      Permission.RESERVATION_MANAGE,
      // Bills settle at the desk on the way out.
      Permission.BILL_VIEW,
      Permission.PAYMENT_COLLECT,
      // Deliberately absent: everything kitchen-facing (KOT_VIEW), order
      // authoring, voids, transfers, reports and configuration — the desk
      // neither works the floor nor runs the shift.
    ],
  },
];

/** Every template, for iteration in seeds and tests. */
export const ALL_ROLE_TEMPLATES: readonly RoleTemplate[] = [
  ...BUILT_IN_ROLE_TEMPLATES,
  ...RESTAURANT_ROLE_TEMPLATES,
  ...HOTEL_ROLE_TEMPLATES,
];

/** Lookup helpers for composing the per-template lists below. Throw rather
 *  than return undefined: a misspelled key must fail the build's tests, not
 *  seed a tenant with a missing role. */
function template(key: string): RoleTemplate {
  const found = ALL_ROLE_TEMPLATES.find((t) => t.key === key);
  if (!found) throw new Error(`No role template with key "${key}"`);
  return found;
}

/*
 * Which roles each workspace template offers (PO decision, 2026-08-17):
 * fewer, job-shaped options instead of the whole catalogue. The trimmed
 * templates still EXIST above — an existing tenant's rows are untouched, and
 * `seedTenantRoles` never deletes a role — but a NEW workspace is seeded with
 * only the roles its business actually staffs, and the console's role picker
 * (which reads the workspace's own rows, D55.1) shrinks to match. The Owner
 * is every list's first entry because a workspace is created around one.
 */

/** Hardware / retail: Owner and Cashier. */
export const HARDWARE_ROLE_TEMPLATES: readonly RoleTemplate[] = [
  template(UserRole.Owner),
  template(UserRole.Cashier),
];

/**
 * Food service (restaurant / cafe / bakery): Owner, Waiter, Cashier, Kitchen
 * staff. The fourth is D68: the kitchen board replaced the kitchen printer,
 * and a board needs somebody rostered to it.
 */
export const FOOD_SERVICE_ROLE_TEMPLATES: readonly RoleTemplate[] = [
  template(UserRole.Owner),
  template('WAITER'),
  template('RESTAURANT_CASHIER'),
  template('KITCHEN_STAFF'),
];

/** Hotel: Owner, Waiter, Receptionist. */
export const HOTEL_WORKSPACE_ROLE_TEMPLATES: readonly RoleTemplate[] = [
  template(UserRole.Owner),
  template('WAITER'),
  template('RECEPTIONIST'),
];

// D56: `roleTemplatesForBusinessType` moved to `domains/registry.ts`. The
// business-type → roles question is answered by the domain descriptor now,
// not by an if-chain here that each new vertical had to remember to extend
// (this one silently handed an unknown type the built-in roles only).
// Consumers importing it from the package root are unaffected.
