import { UserRole } from '@hardware-pos/database';

/**
 * D55.1 — the enum role that sits underneath a workspace role.
 *
 * ## Why a user needs both
 *
 * `User.role` is a persisted enum of five platform roles; the restaurant roles
 * (Waiter, Kitchen Staff, …) are `Role` *rows*, deliberately — see the header of
 * `role-templates.ts`. A user assigned one of those rows still has to store
 * something in the enum column, and `PermissionResolver` ignores it whenever
 * `roleId` resolves, so it is not what grants their authority.
 *
 * It is not dead, though. A handful of checks still read the enum directly —
 * `BranchScopeGuard` and `UsersService` treat OWNER/ADMIN as cross-branch, and
 * `QuotationsService` gates admin actions on it. So the value chosen here is a
 * real privilege decision, not bookkeeping.
 *
 * ## Why the fallback is CASHIER
 *
 * The least-privileged built-in. A custom role's enum is only ever consulted by
 * those OWNER/ADMIN checks and by `LEGACY_FALLBACK` resolution — the state a
 * user lands in if their role row is later deleted. Both should fail *closed*:
 * a waiter must not gain cross-branch visibility because the enum column had to
 * hold something, and must not inherit manager permissions if their role row
 * goes away. This mirrors what the seed does for the restaurant waiter, who is
 * enum CASHIER linked to the WAITER row.
 */
const BUILT_IN = new Set<string>(Object.values(UserRole));

/**
 * `roleKey` is nullable because `Role.key` is: a tenant-created role has no
 * template identity, and that is the clearest possible case for the least
 * privileged answer.
 */
export function baseUserRoleFor(roleKey: string | null): UserRole {
  return roleKey !== null && BUILT_IN.has(roleKey) ? (roleKey as UserRole) : UserRole.CASHIER;
}
