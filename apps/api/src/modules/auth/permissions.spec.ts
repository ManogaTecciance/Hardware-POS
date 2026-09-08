import { UserRole } from '@hardware-pos/database';

import { getRoleDiscountLimit } from '../discounts/discount-limits';
import { ADMIN_LEVEL_ROLES, isAdminLevelRole, Permission, ROLE_PERMISSIONS } from './permissions';

/**
 * SALESPERSON is defined as an owner-equivalent role. These specs pin that
 * definition so a permission added for the owner can never silently skip it.
 */
describe('SALESPERSON ↔ OWNER parity', () => {
  it('holds exactly the owner permission set', () => {
    expect([...ROLE_PERMISSIONS.SALESPERSON].sort()).toEqual([...ROLE_PERMISSIONS.OWNER].sort());
  });

  it('holds every declared permission', () => {
    const all = Object.values(Permission).sort();
    expect([...ROLE_PERMISSIONS.SALESPERSON].sort()).toEqual(all);
  });

  it('shares the owner’s unlimited discount ceiling', () => {
    expect(getRoleDiscountLimit('SALESPERSON')).toBe(getRoleDiscountLimit('OWNER'));
    expect(getRoleDiscountLimit('SALESPERSON')).toBeNull();
  });

  it('counts as an owner-level role for admin-only overrides', () => {
    expect(isAdminLevelRole('SALESPERSON')).toBe(true);
    expect(ADMIN_LEVEL_ROLES).toContain('SALESPERSON');
  });
});

describe('role tables stay exhaustive', () => {
  const roles = Object.values(UserRole);

  it.each(roles)('%s has a permission list', (role) => {
    expect(ROLE_PERMISSIONS[role]).toBeDefined();
  });

  it.each(roles)('%s has a discount limit', (role) => {
    expect(getRoleDiscountLimit(role)).not.toBeUndefined();
  });

  it('grants no non-owner-level role the full permission set', () => {
    const fullAccess = roles.filter(
      (role) => ROLE_PERMISSIONS[role].length === Object.values(Permission).length,
    );
    expect(fullAccess.sort()).toEqual([...ADMIN_LEVEL_ROLES].sort());
  });
});
