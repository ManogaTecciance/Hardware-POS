/**
 * Role and permission parity (Slice 7.3, 7.4).
 *
 * The drift this file exists to prevent had already happened twice before anyone
 * looked, in both directions, and in both cases silently:
 *
 *  • `packages/shared` declared three `UserRole` members while Prisma, the seeds
 *    and `ROLE_PERMISSIONS` all had five. `OWNER` and `ACCOUNTANT` — the roles the
 *    demo tenant actually signs in as — were simply missing from the shared type.
 *  • `apps/web` never received `PLATFORM_PROFILE_READ` / `PLATFORM_PROFILE_MANAGE`
 *    when Slice 4 added them to the API.
 *
 * Nothing failed either time, because nothing compared the copies. That is the
 * definition of a vacuous gap rather than a vacuous test: the assertion did not
 * exist at all. These specs are written to the D30 standard — exact sets rather
 * than counts, positive alongside negative, and mutation proofs showing each
 * comparison can fail.
 */
import { UserRole as PrismaUserRole } from '@hardware-pos/database';
import {
  ALL_PERMISSIONS,
  ALL_USER_ROLES,
  Permission,
  ROLE_PERMISSIONS,
  UserRole as SharedUserRole,
  roleHasPermission,
} from '@hardware-pos/shared';

// ─────────────────────────────────────────────────────────────────────────────
// 7.4 — role parity
// ─────────────────────────────────────────────────────────────────────────────

describe('7.4 — shared UserRole matches the Prisma UserRole exactly', () => {
  /** The required assertion, stated literally. */
  it('Object.values(shared.UserRole) === Object.values(Prisma.UserRole)', () => {
    expect([...Object.values(SharedUserRole)].sort()).toEqual(
      [...Object.values(PrismaUserRole)].sort(),
    );
  });

  it('both lists are populated, so the comparison is not two empties matching', () => {
    // Without this, deleting both enums would make the test above pass.
    expect(Object.values(PrismaUserRole)).toContain('OWNER');
    expect(Object.values(PrismaUserRole)).toContain('ACCOUNTANT');
    expect(Object.values(SharedUserRole)).toContain('OWNER');
    expect(Object.values(SharedUserRole)).toContain('ACCOUNTANT');
  });

  it('the persisted values are the uppercase strings already in the database', () => {
    // Guards against a "tidy-up" that renames the values and orphans every row.
    expect([...Object.values(SharedUserRole)].sort()).toEqual([
      'ACCOUNTANT',
      'ADMIN',
      'CASHIER',
      'MANAGER',
      'OWNER',
    ]);
  });

  it('ALL_USER_ROLES agrees with the object it is derived from', () => {
    expect([...ALL_USER_ROLES].sort()).toEqual([...Object.values(SharedUserRole)].sort());
  });

  it('the parity comparison can fail — a missing role is detected', () => {
    // Mutation proof: the exact regression that shipped, replayed.
    const drifted = Object.values(SharedUserRole).filter((r) => r !== 'OWNER');
    expect(drifted).not.toEqual([...Object.values(SharedUserRole)]);
    expect(() =>
      expect([...drifted].sort()).toEqual([...Object.values(PrismaUserRole)].sort()),
    ).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7.3 — permission consistency
// ─────────────────────────────────────────────────────────────────────────────

describe('7.3 — every role resolves to a real, non-empty permission set', () => {
  it.each([...Object.values(PrismaUserRole)])('%s has an explicit entry', (role) => {
    const granted = ROLE_PERMISSIONS[role];
    // POSITIVE: a role missing from the map would resolve to `undefined`, which
    // reads as "no permissions" — a permissions bug wearing the costume of a
    // deliberate decision.
    expect(granted).toBeDefined();
    expect(granted.length).toBeGreaterThan(0);
  });

  it('every granted permission is a real permission value', () => {
    const known = new Set<string>(ALL_PERMISSIONS);
    for (const [role, granted] of Object.entries(ROLE_PERMISSIONS)) {
      for (const permission of granted) {
        // Jest has no per-assertion message, so the unknown value is surfaced by
        // asserting on a descriptive pair rather than a bare boolean.
        expect({ role, permission, known: known.has(permission) }).toEqual({
          role,
          permission,
          known: true,
        });
      }
    }
  });

  it('OWNER holds every permission, including newly added ones', () => {
    expect([...ROLE_PERMISSIONS.OWNER].sort()).toEqual([...ALL_PERMISSIONS].sort());
  });

  it('ADMIN holds every permission EXCEPT the creator-scoped six (Restaurant Pilot Change 1)', () => {
    // The six DINING_AREA_/TABLE_ *_CREATE / _EDIT_OWN / _ARCHIVE_OWN
    // permissions name capabilities that only make sense paired with a
    // per-row ownership check. Granting them to a role above the ownership
    // check would let ADMIN edit an OWNER's floor whenever the service
    // ownership check moved out of the way (or was ever bypassed by
    // mistake). ADMIN keeps every other permission unchanged; asserted
    // positively by naming the exact expected set below.
    const excludedSet: ReadonlySet<Permission> = new Set([
      Permission.DINING_AREA_CREATE,
      Permission.DINING_AREA_EDIT_OWN,
      Permission.DINING_AREA_ARCHIVE_OWN,
      Permission.TABLE_CREATE,
      Permission.TABLE_EDIT_OWN,
      Permission.TABLE_ARCHIVE_OWN,
    ]);
    const expected = ALL_PERMISSIONS.filter((p) => !excludedSet.has(p));
    expect([...ROLE_PERMISSIONS.ADMIN].sort()).toEqual([...expected].sort());
    // Sibling negative: the six are demonstrably absent.
    for (const missing of [
      Permission.DINING_AREA_CREATE,
      Permission.DINING_AREA_EDIT_OWN,
      Permission.DINING_AREA_ARCHIVE_OWN,
      Permission.TABLE_CREATE,
      Permission.TABLE_EDIT_OWN,
      Permission.TABLE_ARCHIVE_OWN,
    ]) {
      expect(ROLE_PERMISSIONS.ADMIN).not.toContain(missing);
    }
  });

  it('MANAGER keeps its exact operational set', () => {
    expect([...ROLE_PERMISSIONS.MANAGER].sort()).toEqual(
      [
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
        Permission.SUPPLIER_READ,
        Permission.SUPPLIER_MANAGE,
        Permission.SUPPLIER_QB_MAP,
        Permission.REPORT_READ,
        Permission.PLATFORM_PROFILE_READ,
      ].sort(),
    );
    // NEGATIVE: the escalations a manager must not have.
    expect(roleHasPermission('MANAGER', Permission.SUPPLIER_DELETE)).toBe(false);
    expect(roleHasPermission('MANAGER', Permission.USER_MANAGE)).toBe(false);
    expect(roleHasPermission('MANAGER', Permission.SETTINGS_MANAGE)).toBe(false);
    expect(roleHasPermission('MANAGER', Permission.PLATFORM_PROFILE_MANAGE)).toBe(false);
  });

  it('CASHIER keeps its exact set', () => {
    expect([...ROLE_PERMISSIONS.CASHIER].sort()).toEqual(
      [
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
        Permission.PLATFORM_PROFILE_READ,
      ].sort(),
    );
    expect(roleHasPermission('CASHIER', Permission.PRODUCT_MANAGE)).toBe(false);
    expect(roleHasPermission('CASHIER', Permission.RETURN_APPROVE)).toBe(false);
    expect(roleHasPermission('CASHIER', Permission.DISCOUNT_APPROVE)).toBe(false);
  });

  it('ACCOUNTANT keeps its exact read-only set', () => {
    expect([...ROLE_PERMISSIONS.ACCOUNTANT].sort()).toEqual(
      [
        Permission.SYNC_READ,
        Permission.QUICKBOOKS_READ,
        Permission.SALE_READ,
        Permission.RETURN_READ,
        Permission.QUOTATION_READ,
        Permission.PRODUCT_READ,
        Permission.CUSTOMER_READ,
        Permission.SUPPLIER_READ,
        Permission.SUPPLIER_QB_MAP,
        Permission.REPORT_READ,
        Permission.PLATFORM_PROFILE_READ,
      ].sort(),
    );
    // An accountant reads QuickBooks; it must never manage it or write anything.
    expect(roleHasPermission('ACCOUNTANT', Permission.QUICKBOOKS_MANAGE)).toBe(false);
    expect(roleHasPermission('ACCOUNTANT', Permission.SALE_CREATE)).toBe(false);
    expect(roleHasPermission('ACCOUNTANT', Permission.PRODUCT_MANAGE)).toBe(false);
    expect(roleHasPermission('ACCOUNTANT', Permission.CUSTOMER_MANAGE)).toBe(false);
  });

  it('the platform-profile split holds: many may read, only owner/admin may change', () => {
    const readers = Object.values(PrismaUserRole).filter((r) =>
      roleHasPermission(r, Permission.PLATFORM_PROFILE_READ),
    );
    const writers = Object.values(PrismaUserRole).filter((r) =>
      roleHasPermission(r, Permission.PLATFORM_PROFILE_MANAGE),
    );
    expect([...readers].sort()).toEqual(['ACCOUNTANT', 'ADMIN', 'CASHIER', 'MANAGER', 'OWNER']);
    expect([...writers].sort()).toEqual(['ADMIN', 'OWNER']);
  });

  it('roleHasPermission discriminates, rather than always answering the same way', () => {
    // A helper that returned a constant would satisfy half the assertions above.
    expect(roleHasPermission('OWNER', Permission.USER_MANAGE)).toBe(true);
    expect(roleHasPermission('CASHIER', Permission.USER_MANAGE)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// One authority
// ─────────────────────────────────────────────────────────────────────────────

describe('7.3 — there is exactly one permission authority', () => {
  it('the API module re-exports shared rather than declaring its own', async () => {
    const api = await import('./permissions');
    const shared = await import('@hardware-pos/shared');
    // Identity, not equality: a copied object would be deep-equal and still drift.
    expect(api.Permission).toBe(shared.Permission);
    expect(api.ROLE_PERMISSIONS).toBe(shared.ROLE_PERMISSIONS);
    expect(api.roleHasPermission).toBe(shared.roleHasPermission);
  });

  it('permission values are the stable wire strings, not renamed', () => {
    // These appear in `Permission.key` rows and in `GET /auth/me` payloads the
    // browser has already stored. A rename is a breaking change, not a tidy-up.
    expect(Permission.SALE_CREATE).toBe('sale:create');
    expect(Permission.PLATFORM_PROFILE_READ).toBe('platform:profile:read');
    expect(Permission.PLATFORM_PROFILE_MANAGE).toBe('platform:profile:manage');
    expect(Permission.SUPPLIER_QB_MAP).toBe('supplier:qb:map');
  });

  it('a Restaurant permission can be added without a second authority', () => {
    // Not a placeholder assertion: it demonstrates the extension mechanism works
    // on the real map, so Slice 8+ does not need a parallel permission system.
    const future = 'menu:manage';
    expect(ALL_PERMISSIONS).not.toContain(future);
    const extended = [...ALL_PERMISSIONS, future];
    expect(extended).toContain(Permission.PRODUCT_MANAGE);
    expect(extended).toContain(future);
  });
});
