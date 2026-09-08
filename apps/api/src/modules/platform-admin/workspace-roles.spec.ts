/**
 * D55.1 — the enum role stored underneath a workspace role.
 *
 * ## Why this is worth a spec of its own
 *
 * `User.role` looks like bookkeeping once `roleId` is set — `PermissionResolver`
 * ignores it whenever the linked role resolves. It is not. `BranchScopeGuard`,
 * `AuthRepository` and `UsersService` still read the enum directly and treat the
 * owner-level roles — `isAdminLevelRole`: OWNER, ADMIN and, since D108, the
 * hardware template's SALESPERSON — as cross-branch, and it is what
 * `LEGACY_FALLBACK` resolution falls back to if the linked role row is ever
 * deleted. So "which enum does a Waiter get" is a real privilege question with
 * a wrong answer available.
 *
 * The load-bearing assertion is therefore the negative one — a custom role must
 * NOT map to an owner-level enum — and it is paired with the positive: the six
 * enum roles map to themselves, exactly, or the function would satisfy every
 * negative by returning CASHIER for everything.
 */
import { UserRole } from '@hardware-pos/database';
import { ADMIN_LEVEL_ROLES } from '@hardware-pos/shared';

import { baseUserRoleFor } from './workspace-roles';

describe('baseUserRoleFor', () => {
  it('maps every built-in role key to its own enum value', () => {
    // An exact map over the whole enum, not a sample: a value added to
    // `UserRole` that this function silently downgrades fails here.
    const mapped = Object.values(UserRole).map((role) => [role, baseUserRoleFor(role)]);
    expect(mapped).toEqual(Object.values(UserRole).map((role) => [role, role]));
  });

  it('maps each operational role to CASHIER — the least-privileged built-in', () => {
    // The keys the templates actually seed (WAITER, RESTAURANT_CASHIER,
    // RECEPTIONIST), plus the keys of templates REMOVED on 2026-08-17 —
    // rows seeded from them still exist in older tenants, and those users
    // must keep failing closed too.
    for (const key of [
      'WAITER',
      'RESTAURANT_CASHIER',
      'RECEPTIONIST',
      'RESTAURANT_MANAGER',
      'KITCHEN_MANAGER',
      'KITCHEN_STAFF',
      'BAR_STAFF',
    ]) {
      expect(baseUserRoleFor(key)).toBe(UserRole.CASHIER);
    }
  });

  it('never grants an owner-level role to a key that is not literally that role', () => {
    // Near misses for every owner-level role — case, trailing whitespace, a
    // plausible alternative spelling — all land on the least-privileged
    // answer. The SALESPERSON misses are D108's: it is the only owner-level
    // template besides the Owner that any workspace is provisioned with, and
    // the hardware workspace alone gets it — so a hand-typed role elsewhere
    // that reaches for the name must land on CASHIER, not on the owner's enum.
    for (const key of [
      'WAITER',
      'KITCHEN_STAFF',
      'Owner',
      'owner',
      'ADMIN ',
      'SUPER_ADMIN',
      '',
      'Salesperson',
      'salesperson',
      'SALESPERSON ',
      'SALES_PERSON',
    ]) {
      expect({ key, mapped: baseUserRoleFor(key) }).toEqual({ key, mapped: UserRole.CASHIER });
    }
    // Positive counterpart: the exact strings DO still work, so the negative
    // above is a statement about matching and not about the function refusing
    // to return an owner-level enum at all.
    expect(baseUserRoleFor('OWNER')).toBe(UserRole.OWNER);
    expect(baseUserRoleFor('ADMIN')).toBe(UserRole.ADMIN);
    expect(baseUserRoleFor('SALESPERSON')).toBe(UserRole.SALESPERSON);
    // …and derived from the authority, so a role added to ADMIN_LEVEL_ROLES is
    // covered here without a second edit. The literal pin beneath it is what
    // makes that addition fail by name rather than pass by derivation.
    expect(ADMIN_LEVEL_ROLES.map((role) => [role, baseUserRoleFor(role)])).toEqual(
      ADMIN_LEVEL_ROLES.map((role) => [role, role]),
    );
    expect([...ADMIN_LEVEL_ROLES].sort()).toEqual(['ADMIN', 'OWNER', 'SALESPERSON']);
  });

  it('maps a role with no key at all to CASHIER', () => {
    // `Role.key` is nullable — a tenant-created role has no template identity.
    expect(baseUserRoleFor(null)).toBe(UserRole.CASHIER);
  });
});
