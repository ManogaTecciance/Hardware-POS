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

describe('built-in role templates match the permission authority', () => {
  it('there is exactly one template per persisted UserRole', () => {
    expect(BUILT_IN_ROLE_TEMPLATES.map((t) => t.key).sort()).toEqual(
      [...Object.values(PrismaUserRole)].sort(),
    );
  });

  it('each template grants exactly what ROLE_PERMISSIONS grants that role', () => {
    // Exact sets per role, not a total count: two roles could swap permission
    // sets and keep the total identical.
    for (const template of BUILT_IN_ROLE_TEMPLATES) {
      const authority = ROLE_PERMISSIONS[template.key as UserRole];
      expect({ role: template.key, granted: [...template.permissions].sort() }).toEqual({
        role: template.key,
        granted: [...authority].sort(),
      });
    }
  });

  it('every built-in template is marked built-in, and no other template is', () => {
    expect(BUILT_IN_ROLE_TEMPLATES.every((t) => t.isBuiltIn)).toBe(true);
    expect(RESTAURANT_ROLE_TEMPLATES.every((t) => !t.isBuiltIn)).toBe(true);
    // Positive control: both collections are populated, so neither `every` is
    // vacuously true.
    expect(BUILT_IN_ROLE_TEMPLATES.length).toBe(5);
    expect(RESTAURANT_ROLE_TEMPLATES.length).toBeGreaterThan(0);
  });

  it('owner holds the whole catalogue, including reserved keys', () => {
    // The invariant that keeps "owner can do everything" true as the catalogue
    // grows — including permissions whose features do not exist yet.
    const owner = BUILT_IN_ROLE_TEMPLATES.find((t) => t.key === 'OWNER')!;
    expect([...owner.permissions].sort()).toEqual([...ALL_PERMISSIONS].sort());
  });

  it('admin holds the catalogue MINUS the six creator-scoped permissions (Restaurant Pilot Change 1)', () => {
    // The six DINING_AREA_/TABLE_ *_CREATE / _EDIT_OWN / _ARCHIVE_OWN keys
    // name capabilities that only make sense paired with the ownership check
    // inside the service. Granting them at the role level to anyone above
    // that check — even ADMIN — would let a role bypass ownership the moment
    // the check moved. `authorization.ts` filters them out of ADMIN's set;
    // this parity spec pins the derivation so a future "make ADMIN total
    // again" edit trips a red test.
    const admin = BUILT_IN_ROLE_TEMPLATES.find((t) => t.key === 'ADMIN')!;
    const excluded: readonly Permission[] = [
      Permission.DINING_AREA_CREATE,
      Permission.DINING_AREA_EDIT_OWN,
      Permission.DINING_AREA_ARCHIVE_OWN,
      Permission.TABLE_CREATE,
      Permission.TABLE_EDIT_OWN,
      Permission.TABLE_ARCHIVE_OWN,
    ];
    const expected = ALL_PERMISSIONS.filter((p) => !excluded.includes(p));
    expect([...admin.permissions].sort()).toEqual([...expected].sort());
    for (const missing of excluded) {
      expect(admin.permissions).not.toContain(missing);
    }
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
  it('a hardware tenant gets Owner and Cashier, and no restaurant role', () => {
    const keys = roleTemplatesForBusinessType('HARDWARE').map((t) => t.key);
    expect(keys.sort()).toEqual(['CASHIER', 'OWNER']);
  });

  it('a GENERAL tenant keeps the five built-ins — the deliberately-plain template', () => {
    const keys = roleTemplatesForBusinessType('GENERAL').map((t) => t.key);
    expect(keys.sort()).toEqual(BUILT_IN_ROLE_TEMPLATES.map((t) => t.key).sort());
  });

  it('a food-service tenant gets Owner, Waiter and (Restaurant) Cashier', () => {
    for (const type of ['RESTAURANT', 'CAFE', 'BAKERY']) {
      const keys = roleTemplatesForBusinessType(type).map((t) => t.key);
      expect({ type, keys: keys.sort() }).toEqual({
        type,
        keys: ['OWNER', 'RESTAURANT_CASHIER', 'WAITER'],
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
    // Negative: WAITER's permission list does NOT include TABLE_TRANSFER
    // or TABLE_MERGE — that's the deliberate split from role-templates.ts.
    expect(waiter.permissions).not.toContain(Permission.TABLE_TRANSFER);
    expect(waiter.permissions).not.toContain(Permission.TABLE_MERGE);
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
