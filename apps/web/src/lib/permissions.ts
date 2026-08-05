/**
 * Roles and permissions for client-side UI gating.
 *
 * **This file defines neither.** Since Slice 7.3 the single authority is
 * `@hardware-pos/shared`, which the API re-exports too, so the two can no longer
 * drift. Everything below is either a re-export or genuinely browser-only.
 *
 * It previously held a hand-maintained copy of the API's list, and that copy had
 * already fallen behind: `PLATFORM_PROFILE_READ` and `PLATFORM_PROFILE_MANAGE`
 * were added to the API in Slice 4 and never reached here. Nothing compared them,
 * so nothing failed — the client simply could not express a permission the server
 * was already granting. Slice 8's module-aware navigation depends on that list
 * being complete, which is why it is fixed now rather than then.
 *
 * Client-side gating is a usability affordance only. Every route is enforced
 * server-side by `PermissionsGuard` and, where applicable, `ModuleAccessGuard`;
 * hiding a control here does not protect anything.
 */

export {
  ALL_PERMISSIONS,
  ALL_USER_ROLES,
  Permission,
  ROLE_PERMISSIONS,
  UserRole,
  roleHasPermission,
} from '@hardware-pos/shared';

import { ROLE_PERMISSIONS, type Permission, type UserRole } from '@hardware-pos/shared';

/** The permissions a role holds, as a mutable copy the session store can own. */
export function permissionsForRole(role: UserRole): Permission[] {
  return [...(ROLE_PERMISSIONS[role] ?? [])];
}

/**
 * Max manual discount (% of line) a role may apply without approval.
 * `null` = unlimited.
 *
 * Genuinely browser-only, so it stays here: the server enforces discount limits
 * from `TenantSettings.highDiscountThresholdPercent` and the approver's own role,
 * and this table only decides whether the POS prompts for approval before asking.
 */
export const ROLE_DISCOUNT_LIMIT_PERCENT: Record<UserRole, number | null> = {
  OWNER: null,
  ADMIN: null,
  MANAGER: 15,
  CASHIER: 0,
  ACCOUNTANT: 0,
};

export function discountLimitFor(role: UserRole): number | null {
  return ROLE_DISCOUNT_LIMIT_PERCENT[role];
}

/** True when `limit` (null = unlimited) permits a discount of `percent`. */
export function withinDiscountLimit(limit: number | null, percent: number): boolean {
  return limit === null || percent <= limit + 1e-9;
}
