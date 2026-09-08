import { describe, expect, it } from 'vitest';

import {
  ADMIN_LEVEL_ROLES,
  discountLimitFor,
  isAdminLevelRole,
  permissionsForRole,
  Permission,
  ROLE_PERMISSIONS,
  type UserRole,
} from '@/lib/permissions';

import { resolveDashboardVariant } from './roles';

/**
 * The web mirrors the API's role tables by hand, so these specs pin the mirror.
 * A permission granted to the owner in `lib/permissions.ts` must reach the
 * salesperson too — nothing else on this side checks that.
 */
describe('SALESPERSON ↔ OWNER parity (web mirror)', () => {
  it('holds exactly the owner permission set', () => {
    expect([...ROLE_PERMISSIONS.SALESPERSON].sort()).toEqual([...ROLE_PERMISSIONS.OWNER].sort());
  });

  it('resolves to every declared permission via permissionsForRole', () => {
    expect([...permissionsForRole('SALESPERSON')].sort()).toEqual(Object.values(Permission).sort());
  });

  it('shares the owner’s unlimited discount ceiling', () => {
    expect(discountLimitFor('SALESPERSON')).toBe(discountLimitFor('OWNER'));
    expect(discountLimitFor('SALESPERSON')).toBeNull();
  });

  it('counts as an owner-level role', () => {
    expect(isAdminLevelRole('SALESPERSON')).toBe(true);
  });

  it('grants no role outside ADMIN_LEVEL_ROLES the full permission set', () => {
    const fullAccess = (Object.keys(ROLE_PERMISSIONS) as UserRole[]).filter(
      (role) => ROLE_PERMISSIONS[role].length === Object.values(Permission).length,
    );
    // Exactly the two owner-equivalents. On main this equalled ADMIN_LEVEL_ROLES;
    // after the restaurant merge ADMIN stays owner-level for guard-rail overrides
    // but no longer holds the full catalogue (Restaurant Pilot Change 1 withholds
    // the six creator-scoped permissions). So: who holds everything, and that
    // everyone who does is owner-level — asserted separately.
    expect([...fullAccess].sort()).toEqual(['OWNER', 'SALESPERSON']);
    for (const role of fullAccess) expect(ADMIN_LEVEL_ROLES).toContain(role);
    expect(ADMIN_LEVEL_ROLES).toContain('ADMIN');
    expect(ROLE_PERMISSIONS.ADMIN.length).toBeLessThan(Object.values(Permission).length);
  });
});

describe('resolveDashboardVariant', () => {
  it.each([
    ['OWNER', 'admin'],
    ['ADMIN', 'admin'],
    ['SALESPERSON', 'admin'],
    ['MANAGER', 'admin'],
    ['ACCOUNTANT', 'admin'],
    ['CASHIER', 'cashier'],
  ] as const)('%s → %s dashboard', (role, variant) => {
    expect(resolveDashboardVariant(role)).toBe(variant);
  });

  it('covers every role the permission table declares', () => {
    const roles = Object.keys(ROLE_PERMISSIONS) as UserRole[];
    for (const role of roles) {
      expect(['admin', 'cashier']).toContain(resolveDashboardVariant(role));
    }
  });
});
