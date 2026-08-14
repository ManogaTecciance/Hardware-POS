/**
 * D55.1 — the enum role stored underneath a workspace role.
 *
 * ## Why this is worth a spec of its own
 *
 * `User.role` looks like bookkeeping once `roleId` is set — `PermissionResolver`
 * ignores it whenever the linked role resolves. It is not. `BranchScopeGuard`
 * and `UsersService` still read the enum directly and treat OWNER/ADMIN as
 * cross-branch, and it is what `LEGACY_FALLBACK` resolution falls back to if the
 * linked role row is ever deleted. So "which enum does a Waiter get" is a real
 * privilege question with a wrong answer available.
 *
 * The load-bearing assertion is therefore the negative one — a custom role must
 * NOT map to OWNER or ADMIN — and it is paired with the positive: the five
 * built-ins map to themselves, exactly, or the function would satisfy every
 * negative by returning CASHIER for everything.
 */
import { UserRole } from '@hardware-pos/database';

import { baseUserRoleFor } from './workspace-roles';

describe('baseUserRoleFor', () => {
  it('maps every built-in role key to its own enum value', () => {
    // An exact map over the whole enum, not a sample: a value added to
    // `UserRole` that this function silently downgrades fails here.
    const mapped = Object.values(UserRole).map((role) => [role, baseUserRoleFor(role)]);
    expect(mapped).toEqual(Object.values(UserRole).map((role) => [role, role]));
  });

  it('maps each restaurant role to CASHIER — the least-privileged built-in', () => {
    // The keys `RESTAURANT_ROLE_TEMPLATES` actually seeds. Named literally so a
    // renamed template does not quietly stop being covered.
    for (const key of [
      'WAITER',
      'RESTAURANT_MANAGER',
      'RESTAURANT_CASHIER',
      'KITCHEN_MANAGER',
      'KITCHEN_STAFF',
      'BAR_STAFF',
    ]) {
      expect(baseUserRoleFor(key)).toBe(UserRole.CASHIER);
    }
  });

  it('never grants OWNER or ADMIN to a role that is not literally OWNER or ADMIN', () => {
    for (const key of ['WAITER', 'KITCHEN_STAFF', 'Owner', 'owner', 'ADMIN ', 'SUPER_ADMIN', '']) {
      expect(baseUserRoleFor(key)).toBe(UserRole.CASHIER);
    }
    // Positive counterpart: the exact strings DO still work, so the negative
    // above is a statement about matching and not about the function refusing
    // to return OWNER at all.
    expect(baseUserRoleFor('OWNER')).toBe(UserRole.OWNER);
    expect(baseUserRoleFor('ADMIN')).toBe(UserRole.ADMIN);
  });

  it('maps a role with no key at all to CASHIER', () => {
    // `Role.key` is nullable — a tenant-created role has no template identity.
    expect(baseUserRoleFor(null)).toBe(UserRole.CASHIER);
  });
});
