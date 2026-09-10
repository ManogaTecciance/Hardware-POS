/**
 * Role-template and permission parity (Phase 1.5, D36/D37).
 *
 * The Product Owner required parity across four copies of the same vocabulary:
 * the code catalogue, the seeded assignments, the API's permission decorators,
 * and the frontend constants. Slice 7.3 already ended the drift between three of
 * them by making `packages/shared` the single authority; this file covers what
 * Phase 1.5 adds — role *templates*, which are a second statement of
 * `ROLE_PERMISSIONS` and could drift from it the moment someone edits one.
 *
 * ## What makes these non-vacuous
 *
 * Every set comparison is exact, never a count. Every "X is absent" is paired with
 * a positive control proving the collection being searched is populated. The
 * reserved-permission assertions matter most: they are the claim that no
 * restaurant feature is implemented, and they would pass trivially against a route
 * probe that found nothing — so the probe's own output is asserted first.
 */
import {
  ACTIVE_PERMISSIONS,
  ALL_PERMISSIONS,
  ALL_ROLE_TEMPLATES,
  BUILT_IN_ROLE_TEMPLATES,
  BUSINESS_TYPE_VALUES,
  Permission,
  RESERVED_PERMISSIONS,
  RESTAURANT_ROLE_TEMPLATES,
  ROLE_PERMISSIONS,
  roleTemplatesForBusinessType,
  UserRole,
} from '@hardware-pos/shared';
import { UserRole as PrismaUserRole } from '@hardware-pos/database';

import { ALL_CONTROLLERS } from '../../common/testkit/controller-registry';
import { collectRoutes } from '../../common/testkit/route-inventory';

// ─────────────────────────────────────────────────────────────────────────────
// Built-in templates mirror ROLE_PERMISSIONS exactly
// ─────────────────────────────────────────────────────────────────────────────

describe('the template catalogue is exactly what the workspace templates staff', () => {
  it('exactly seven templates exist — the removed ones stay removed', () => {
    /*
     * PO decision, 2026-08-17: the unstaffed blueprints (Admin, Manager,
     * Accountant, Restaurant Manager, Kitchen Manager, Bar Staff) were
     * DELETED, not parked. Exact set both ways: a template added back — or
     * dropped — fails here by name. The UserRole ENUM keeps all six values
     * (persisted data, legacy-fallback authority — SALESPERSON joined it on
     * 2026-08-31, and D108 gave it a template that only the hardware
     * workspace offers); this is about what NEW workspaces are seeded with.
     *
     * KITCHEN_STAFF was the first addition since, and it is not a walk-back
     * of that decision: D68 withdrew kitchen printing, which turned the
     * kitchen board into the only place a ticket is ever delivered and
     * created a job — watch the board, mark food done — that nothing else in
     * the catalogue covers. SALESPERSON is the second (D108): the hardware
     * shop's owner-equivalent counter post, offered by that template alone.
     * The bar remains "a template must name a job someone is rostered to".
     */
    expect(ALL_ROLE_TEMPLATES.map((t) => t.key).sort()).toEqual([
      'CASHIER',
      'KITCHEN_STAFF',
      'OWNER',
      'RECEPTIONIST',
      'RESTAURANT_CASHIER',
      'SALESPERSON',
      'WAITER',
    ]);
  });

  it('each surviving built-in template grants exactly what ROLE_PERMISSIONS grants', () => {
    // Exact sets per role, not a total count: two roles could swap permission
    // sets and keep the total identical. The enum authority has six entries;
    // OWNER, CASHIER and (D108) SALESPERSON are the ones with templates.
    expect(BUILT_IN_ROLE_TEMPLATES.map((t) => t.key).sort()).toEqual([
      'CASHIER',
      'OWNER',
      'SALESPERSON',
    ]);
    for (const template of BUILT_IN_ROLE_TEMPLATES) {
      const authority = ROLE_PERMISSIONS[template.key as UserRole];
      expect({ role: template.key, granted: [...template.permissions].sort() }).toEqual({
        role: template.key,
        granted: [...authority].sort(),
      });
    }
    // The authority the templates no longer mirror is still whole — removing
    // a TEMPLATE must not have touched the enum's permission sets.
    expect(Object.keys(ROLE_PERMISSIONS).sort()).toEqual(
      [...Object.values(PrismaUserRole)].sort(),
    );
  });

  it('every built-in template is marked built-in, and no other template is', () => {
    // Exact key sets over the whole catalogue, both ways: a template that
    // gained or lost the flag fails here by name, and neither side can be
    // vacuously true. "Built in" says who owns a definition (enum-backed,
    // undeletable); since D108 it no longer says who is seeded with it — the
    // per-template lists do — which is why the flagged set is three and the
    // GENERAL workspace still receives two.
    const byFlag = (isBuiltIn: boolean) =>
      ALL_ROLE_TEMPLATES.filter((t) => t.isBuiltIn === isBuiltIn)
        .map((t) => t.key)
        .sort();
    expect(byFlag(true)).toEqual(['CASHIER', 'OWNER', 'SALESPERSON']);
    expect(byFlag(false)).toEqual(['KITCHEN_STAFF', 'RECEPTIONIST', 'RESTAURANT_CASHIER', 'WAITER']);
    // The list and the flag agree: `BUILT_IN_ROLE_TEMPLATES` is exactly the
    // flagged set, and nothing in the restaurant list carries the flag.
    expect(BUILT_IN_ROLE_TEMPLATES.map((t) => t.key).sort()).toEqual(byFlag(true));
    expect(RESTAURANT_ROLE_TEMPLATES.filter((t) => t.isBuiltIn).map((t) => t.key)).toEqual([]);
    expect(RESTAURANT_ROLE_TEMPLATES.map((t) => t.key).sort()).toEqual([
      'KITCHEN_STAFF',
      'RESTAURANT_CASHIER',
      'WAITER',
    ]);
  });

  /**
   * D108 — the Salesperson IS the owner, permission for permission. Asserted
   * three ways because each catches a different way of breaking it: the
   * template equals the owner template (what a tenant is seeded with), the
   * enum authority binds both roles to ONE array (what the legacy fallback
   * grants — by reference, so the two cannot be edited apart), and the set is
   * not some third thing both happen to share (the negative control).
   */
  it('the salesperson template grants exactly what the owner template grants', () => {
    const owner = BUILT_IN_ROLE_TEMPLATES.find((t) => t.key === 'OWNER')!;
    const salesperson = BUILT_IN_ROLE_TEMPLATES.find((t) => t.key === 'SALESPERSON')!;
    expect(salesperson).toBeDefined();
    expect([...salesperson.permissions].sort()).toEqual([...owner.permissions].sort());
    expect(salesperson.isBuiltIn).toBe(true);

    // By reference in the authority, not merely equal.
    expect(ROLE_PERMISSIONS.SALESPERSON).toBe(ROLE_PERMISSIONS.OWNER);

    // NEGATIVE — it is the OWNER's set, not ADMIN's narrowed one and not the
    // till's: the equality above is not satisfied by any owner-ish set.
    expect([...salesperson.permissions].sort()).not.toEqual([...ROLE_PERMISSIONS.ADMIN].sort());
    expect([...salesperson.permissions].sort()).not.toEqual([...ROLE_PERMISSIONS.CASHIER].sort());
  });

  it('owner holds the whole catalogue, including reserved keys', () => {
    // The invariant that keeps "owner can do everything" true as the catalogue
    // grows — including permissions whose features do not exist yet.
    const owner = BUILT_IN_ROLE_TEMPLATES.find((t) => t.key === 'OWNER')!;
    expect([...owner.permissions].sort()).toEqual([...ALL_PERMISSIONS].sort());
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Keys and uniqueness
// ─────────────────────────────────────────────────────────────────────────────

describe('template keys are stable identifiers', () => {
  it('every key is unique across all templates', () => {
    const keys = ALL_ROLE_TEMPLATES.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('no key collides with a display name', () => {
    // `Role` is unique on (tenantId, name) AND (tenantId, key). A template whose
    // key equals another's name would collide on insert for reasons no one could
    // read from the error.
    const names = new Set(ALL_ROLE_TEMPLATES.map((t) => t.name));
    const collisions = ALL_ROLE_TEMPLATES.filter((t) => names.has(t.key)).map((t) => t.key);
    expect(collisions).toEqual([]);
  });

  it('keys are upper snake case, so they read as identifiers rather than labels', () => {
    const malformed = ALL_ROLE_TEMPLATES.filter((t) => !/^[A-Z][A-Z_]*$/.test(t.key));
    expect(malformed.map((t) => t.key)).toEqual([]);
  });

  it('every template grants only permissions the catalogue knows', () => {
    // D37: unknown permission values must fail closed. This is the compile-time
    // guarantee restated at runtime, because a template could be built from a
    // widened type in future.
    const known = new Set<string>(ALL_PERMISSIONS);
    const unknown = ALL_ROLE_TEMPLATES.flatMap((t) =>
      t.permissions.filter((p) => !known.has(p)).map((p) => `${t.key}:${p}`),
    );
    expect(unknown).toEqual([]);
    // Positive control: the templates do grant things, so the filter ran.
    expect(ALL_ROLE_TEMPLATES.flatMap((t) => [...t.permissions]).length).toBeGreaterThan(20);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Which tenants get which templates
// ─────────────────────────────────────────────────────────────────────────────

describe('templates are selected by business type', () => {
  /*
   * PO decision, 2026-08-17: each workspace template offers the roles its
   * business actually staffs, not the whole catalogue. EXACT sets per type —
   * a role added to or dropped from a template fails here by name.
   */
  it('a hardware tenant gets Owner, Salesperson and Cashier, and no restaurant role', () => {
    const keys = roleTemplatesForBusinessType('HARDWARE').map((t) => t.key);
    expect(keys.sort()).toEqual(['CASHIER', 'OWNER', 'SALESPERSON']);
  });

  it('a GENERAL tenant gets Owner and Cashier — not the hardware-only Salesperson', () => {
    const keys = roleTemplatesForBusinessType('GENERAL').map((t) => t.key);
    expect(keys.sort()).toEqual(['CASHIER', 'OWNER']);
  });

  /**
   * D108 — the Salesperson is the hardware template's alone. The exact-set
   * assertions above and below already imply this; naming it makes a future
   * "why not offer it to hotels too" edit fail by name, and the positive
   * control (every list still has its owner) proves the lists were populated.
   */
  it('no template but HARDWARE offers the Salesperson', () => {
    // Iterated from the enum, not a hand-written list, so a business type
    // added later is inspected here without a second edit.
    const offering = BUSINESS_TYPE_VALUES.filter((type) =>
      roleTemplatesForBusinessType(type).some((t) => t.key === 'SALESPERSON'),
    );
    expect(offering).toEqual(['HARDWARE']);
    for (const type of BUSINESS_TYPE_VALUES.filter((v) => v !== 'HARDWARE')) {
      const keys = roleTemplatesForBusinessType(type).map((t) => t.key);
      expect({ type, salesperson: keys.includes('SALESPERSON'), owner: keys.includes('OWNER') }).toEqual({
        type,
        salesperson: false,
        owner: true,
      });
    }
    // Positive control: the enum is populated, so the loop ran over every
    // other business type rather than an empty list (D30.7).
    expect(BUSINESS_TYPE_VALUES.length).toBeGreaterThan(5);
  });

  it('a food-service tenant gets Owner, Waiter, Cashier and Kitchen staff', () => {
    for (const type of ['RESTAURANT', 'CAFE', 'BAKERY']) {
      const keys = roleTemplatesForBusinessType(type).map((t) => t.key);
      expect({ type, keys: keys.sort() }).toEqual({
        type,
        keys: ['KITCHEN_STAFF', 'OWNER', 'RESTAURANT_CASHIER', 'WAITER'],
      });
    }
  });

  /**
   * D88 — the profile is how the client learns it is a restaurant at all:
   * the navigation, the POS fork and every mode flag hang off it. A
   * food-service role without this permission gets "Navigation unavailable"
   * and the RETAIL checkout, which is exactly what happened to the till.
   *
   * The gap survived because the session store used to re-derive permissions
   * from the enum role on every page load, and the retail CASHIER enum
   * carries PLATFORM_PROFILE_READ — so the missing grant was borrowed from a
   * bug. Asserted across ALL food-service templates, not just the one that
   * broke, because the next one added will have the same requirement.
   */
  it('every food-service template can read the platform profile', () => {
    const missing = RESTAURANT_ROLE_TEMPLATES.filter(
      (t) => !t.permissions.includes(Permission.PLATFORM_PROFILE_READ),
    ).map((t) => t.key);
    expect(missing).toEqual([]);

    // The filter must have inspected something (D30.7): an empty template
    // list would satisfy the assertion above while proving nothing. OWNER is
    // absent by design — it is a built-in, added alongside these three by
    // `roleTemplatesForBusinessType`.
    expect(RESTAURANT_ROLE_TEMPLATES.map((t) => t.key).sort()).toEqual(
      ['KITCHEN_STAFF', 'RESTAURANT_CASHIER', 'WAITER'].sort(),
    );
    // …and the built-in the tenant actually gets alongside them holds it too.
    expect(
      roleTemplatesForBusinessType('RESTAURANT').every((t) =>
        t.permissions.includes(Permission.PLATFORM_PROFILE_READ),
      ),
    ).toBe(true);
  });

  /**
   * D87 — the floor takes takeaway orders too. A seated guest asking for
   * something to take home is still the waiter's order, and the till is where
   * a walk-in takeaway is rung up.
   */
  it('the waiter and the till can both raise a takeaway order', () => {
    const waiter = RESTAURANT_ROLE_TEMPLATES.find((t) => t.key === 'WAITER')!;
    const till = RESTAURANT_ROLE_TEMPLATES.find((t) => t.key === 'RESTAURANT_CASHIER')!;

    expect(waiter.permissions).toContain(Permission.TAKEAWAY_CREATE);
    expect(waiter.permissions).toContain(Permission.TAKEAWAY_VIEW);
    expect(till.permissions).toContain(Permission.TAKEAWAY_CREATE);

    // NEGATIVE — the two roles are still different. The waiter does not take
    // money, and the till does not send food to the kitchen; the POS mode
    // list is built from exactly these two facts (D87).
    expect(waiter.permissions).not.toContain(Permission.PAYMENT_COLLECT);
    expect(till.permissions).not.toContain(Permission.ORDER_SEND_TO_KITCHEN);
  });

  it('the waiter can record WHO a takeaway is for, not just raise it (D146)', () => {
    const waiter = RESTAURANT_ROLE_TEMPLATES.find((t) => t.key === 'WAITER')!;

    /*
     * The counter popup asks for a name and a phone and POSTs a customer, so a
     * waiter holding TAKEAWAY_CREATE without CUSTOMER_MANAGE could start the
     * order and then only finish it as a walk-in — the 403 reached the operator
     * as "you don't have permission to create a customer".
     */
    expect(waiter.permissions).toContain(Permission.TAKEAWAY_CREATE);
    expect(waiter.permissions).toContain(Permission.CUSTOMER_MANAGE);
    expect(waiter.permissions).toContain(Permission.CUSTOMER_READ);

    /*
     * NEGATIVE — and this is the half that matters, because CUSTOMER_MANAGE is
     * the only customer-write key and therefore wider than "create". It buys
     * the waiter nothing on the money side: what the floor may not do is
     * unchanged.
     */
    for (const withheld of [
      Permission.PAYMENT_COLLECT,
      Permission.SALE_READ,
      Permission.REPORT_READ,
      Permission.SETTINGS_MANAGE,
      Permission.USER_MANAGE,
      Permission.ORDER_VOID_SENT,
    ]) {
      expect(waiter.permissions).not.toContain(withheld);
    }
  });

  /**
   * D68 — kitchen staff work the board and nothing else. Asserted as an
   * EXACT set: a permission quietly added here is the difference between
   * "marks food done" and "can settle a table's bill", and the pass is the
   * one place in a restaurant with no till accountability.
   */
  it('Kitchen staff hold exactly the board permissions, and nothing with money in it', () => {
    const kitchen = RESTAURANT_ROLE_TEMPLATES.find((t) => t.key === 'KITCHEN_STAFF');
    expect(kitchen).toBeDefined();
    expect([...kitchen!.permissions].sort()).toEqual(
      [
        Permission.PLATFORM_PROFILE_READ,
        Permission.KOT_VIEW,
        Permission.KITCHEN_STATUS_UPDATE,
      ].sort(),
    );
    // NEGATIVE, by name — the exact-set assertion above already implies these,
    // but naming them is what makes a future widening obviously wrong rather
    // than merely red.
    for (const forbidden of [
      Permission.SALE_CREATE,
      Permission.PAYMENT_COLLECT,
      Permission.BILL_VIEW,
      Permission.TABLE_CLOSE,
      Permission.ORDER_CREATE,
      Permission.REPORT_READ,
    ]) {
      expect({ permission: forbidden, held: kitchen!.permissions.includes(forbidden) }).toEqual({
        permission: forbidden,
        held: false,
      });
    }
  });

  it('a hotel tenant gets Owner, Waiter and Receptionist', () => {
    const keys = roleTemplatesForBusinessType('HOTEL').map((t) => t.key);
    expect(keys.sort()).toEqual(['OWNER', 'RECEPTIONIST', 'WAITER']);
  });

  it('an unrecognised business type is refused, loudly (D56)', () => {
    /*
     * This inverts the previous assertion, deliberately and on record. The
     * old fallback handed an unknown type the built-in roles — the exact
     * silent-wrong-default pattern that gave HOTEL the retail screens. The
     * enum is closed and provisioning validates its input, so the only way
     * to reach this branch is a bug or garbage input; aborting the
     * provisioning transaction beats creating a half-configured tenant.
     * The error names the valid values so the failure is self-explaining.
     */
    expect(() => roleTemplatesForBusinessType('SOMETHING_NEW')).toThrow(
      /Unknown business type "SOMETHING_NEW".*HARDWARE.*GENERAL/,
    );
    // Positive counterpart: a valid value does NOT throw — the guard rejects
    // unknowns, it does not reject everything.
    expect(() => roleTemplatesForBusinessType('HARDWARE')).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Reserved permissions govern nothing — the honest-scope tripwire
// ─────────────────────────────────────────────────────────────────────────────

describe('reserved permissions are reserved, not implemented', () => {
  const routes = collectRoutes(ALL_CONTROLLERS);

  it('the route probe found real routes, so the claims below mean something', () => {
    expect(routes.length).toBeGreaterThan(100);
    // POSITIVE CONTROL: permissions ARE enforced somewhere, so "not enforced" is a
    // meaningful statement rather than an artefact of reading empty metadata.
    const enforced = new Set(routes.flatMap((r) => r.permissions));
    expect(enforced.size).toBeGreaterThan(5);
    expect([...enforced]).toContain(Permission.SALE_READ);
  });

  it('no route requires a reserved permission', () => {
    const enforced = new Set<string>(routes.flatMap((r) => r.permissions));
    const leaked = RESERVED_PERMISSIONS.filter((p) => enforced.has(p));
    // If this fails, a restaurant feature has been wired up. That is not a test
    // failure to silence — it is the moment to move the key out of
    // RESERVED_PERMISSIONS and say the feature is implemented.
    expect(leaked).toEqual([]);
  });

  it('reserved and active permissions partition the catalogue exactly', () => {
    expect([...RESERVED_PERMISSIONS, ...ACTIVE_PERMISSIONS].sort()).toEqual(
      [...ALL_PERMISSIONS].sort(),
    );
    expect(RESERVED_PERMISSIONS.some((p) => ACTIVE_PERMISSIONS.includes(p))).toBe(false);
    expect(RESERVED_PERMISSIONS.length).toBeGreaterThan(0);
    expect(ACTIVE_PERMISSIONS.length).toBeGreaterThan(0);
  });

  it('restaurant roles carry a mix of active and reserved permissions', () => {
    // Phases 5-8 activated most restaurant permissions. What remains
    // reserved (TABLE_TRANSFER, TABLE_MERGE, ORDER_EDIT_DRAFT) still
    // cannot be enforced because no route requires them.
    const waiter = RESTAURANT_ROLE_TEMPLATES.find((t) => t.key === 'WAITER')!;
    const active = waiter.permissions.filter((p) => ACTIVE_PERMISSIONS.includes(p));
    // Positive control: the roles the waiter now genuinely holds live routes for.
    expect(active).toContain(Permission.TABLE_OPEN);
    expect(active).toContain(Permission.TABLE_CLOSE);
    expect(active).toContain(Permission.ORDER_CREATE);
    expect(active).toContain(Permission.ORDER_SEND_TO_KITCHEN);
    /*
     * D151 — the waiter sees the floor. Asserted here, beside the two keys they
     * still do not hold, because the three together ARE the split the template
     * documents: a waiter may READ every table (and work one they can reach,
     * which was never ownership-checked) and still may not move a table's bill
     * or void what the kitchen has started.
     */
    expect(active).toContain(Permission.TABLE_SESSION_VIEW_ALL);
    // Negative: WAITER's permission list does NOT include TABLE_TRANSFER
    // or TABLE_MERGE — that's the deliberate split from role-templates.ts.
    expect(waiter.permissions).not.toContain(Permission.TABLE_TRANSFER);
    expect(waiter.permissions).not.toContain(Permission.TABLE_MERGE);
    // …nor ORDER_VOID_SENT: seeing a colleague's table does not make their
    // mistakes yours to erase.
    expect(waiter.permissions).not.toContain(Permission.ORDER_VOID_SENT);
  });

  it('a waiter cannot reach the kitchen board, sales, reports, or catalogue writes', () => {
    const waiter = RESTAURANT_ROLE_TEMPLATES.find((t) => t.key === 'WAITER')!;
    // These four are exactly what gate the Kitchen / Sales / Reports rail
    // entries and the product-write actions, so their absence IS the rule.
    for (const denied of [
      Permission.KOT_VIEW,
      Permission.SALE_READ,
      Permission.REPORT_READ,
      Permission.PRODUCT_MANAGE,
      Permission.CATEGORY_MANAGE,
      Permission.SETTINGS_MANAGE,
    ]) {
      expect(waiter.permissions).not.toContain(denied);
    }
    // Positive control: the read and send permissions they must keep, so the
    // negatives above cannot be passing because the list is empty.
    expect(waiter.permissions).toContain(Permission.PRODUCT_READ);
    expect(waiter.permissions).toContain(Permission.ORDER_SEND_TO_KITCHEN);
    expect(waiter.permissions).toContain(Permission.TABLE_OPEN);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Mutation proofs
// ─────────────────────────────────────────────────────────────────────────────

describe('the parity assertions can actually fail', () => {
  it('a template that drifted from ROLE_PERMISSIONS would be detected', () => {
    const cashier = BUILT_IN_ROLE_TEMPLATES.find((t) => t.key === 'CASHIER')!;
    expect([...cashier.permissions].sort()).toEqual([...ROLE_PERMISSIONS.CASHIER].sort());

    const drifted = [...cashier.permissions, Permission.SETTINGS_MANAGE].sort();
    expect(() => expect(drifted).toEqual([...ROLE_PERMISSIONS.CASHIER].sort())).toThrow();
  });

  it('a salesperson that lost one owner permission would be detected (D108)', () => {
    const owner = BUILT_IN_ROLE_TEMPLATES.find((t) => t.key === 'OWNER')!;
    const narrowed = owner.permissions.filter((p) => p !== Permission.SETTINGS_MANAGE);
    expect(narrowed.length).toBe(owner.permissions.length - 1);
    expect(() => expect([...narrowed].sort()).toEqual([...owner.permissions].sort())).toThrow();
    // …and a copy that is equal but not the same array fails the by-reference
    // claim, which is the claim that stops the two being edited apart.
    expect(() => expect([...ROLE_PERMISSIONS.OWNER]).toBe(ROLE_PERMISSIONS.OWNER)).toThrow();
  });

  it('a Salesperson leaking into another template would be detected (D108)', () => {
    const hotel = roleTemplatesForBusinessType('HOTEL').map((t) => t.key);
    expect(hotel).not.toContain('SALESPERSON');
    const leaked = [...hotel, 'SALESPERSON'];
    const offering = [
      ['HARDWARE', roleTemplatesForBusinessType('HARDWARE').map((t) => t.key)],
      ['HOTEL', leaked],
    ]
      .filter(([, keys]) => (keys as string[]).includes('SALESPERSON'))
      .map(([type]) => type);
    expect(offering).toEqual(['HARDWARE', 'HOTEL']);
    expect(() => expect(offering).toEqual(['HARDWARE'])).toThrow();
  });

  it('a reserved permission acquiring a route would be detected', () => {
    const enforcedNow = new Set<string>();
    expect(RESERVED_PERMISSIONS.filter((p) => enforcedNow.has(p))).toEqual([]);

    // Use a permission that is STILL reserved (TABLE_TRANSFER).
    const enforcedLater = new Set<string>([Permission.TABLE_TRANSFER]);
    const leaked = RESERVED_PERMISSIONS.filter((p) => enforcedLater.has(p));
    expect(leaked).toEqual([Permission.TABLE_TRANSFER]);
    expect(() => expect(leaked).toEqual([])).toThrow();
  });

  it('a route probe returning nothing would be detected', () => {
    // The guard on the whole reserved-permission section: an empty probe makes
    // "no route requires a reserved permission" true for the wrong reason.
    expect(() => expect([].length).toBeGreaterThan(100)).toThrow();
  });
});
