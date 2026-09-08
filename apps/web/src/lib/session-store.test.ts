/**
 * @vitest-environment jsdom
 */
/**
 * D88 — a stored session keeps the authority the server resolved for it.
 *
 * The defect these tests exist for was invisible until a page reload: login
 * stored the server's permission set, and the very next `loadSession()` threw
 * it away and re-derived from the enum role. A waiter (enum CASHIER, custom
 * role WAITER) pressed F5 and became a retail cashier.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { Permission, permissionsForRole, type UserRole } from './permissions';
import { loadSession, saveSession, type Session } from './session-store';

/*
 * `UserRole` is a TYPE-only export in this package — `UserRole.CASHIER` is
 * `undefined` at runtime, and a test written that way silently compares two
 * empty sets and passes for the wrong reason. The wire value is the string.
 */
const CASHIER = 'CASHIER' as UserRole;

const WAITER_PERMISSIONS = [
  Permission.ORDER_SEND_TO_KITCHEN,
  Permission.TAKEAWAY_CREATE,
  Permission.BILL_SPLIT,
  Permission.TABLE_OPEN,
] as const;

function waiterSession(permissions: unknown): Session {
  return {
    token: 'header.payload.signature',
    refreshToken: 'refresh',
    user: {
      id: 'usr_resto_waiter',
      name: 'Restaurant Waiter',
      email: 'waiter@axlopos.test',
      // The waiter's ENUM role. Their real authority is the WAITER role row,
      // which no enum value corresponds to — that mismatch is the whole bug.
      role: CASHIER,
      tenantId: 'tnt_resto',
      permissions: permissions as Session['user']['permissions'],
    },
    branchId: 'br_1',
    registerId: null,
    branchName: 'Main',
    registerName: '—',
  };
}

describe('loadSession', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('keeps the server-resolved permissions across a reload', () => {
    saveSession(waiterSession([...WAITER_PERMISSIONS]));

    const loaded = loadSession();

    // Positive: every permission the server granted survives.
    expect(loaded?.user.permissions).toEqual([...WAITER_PERMISSIONS]);
    for (const permission of WAITER_PERMISSIONS) {
      expect(loaded?.user.permissions).toContain(permission);
    }
  });

  it('does not hand a custom-role user the authority of their enum role', () => {
    saveSession(waiterSession([...WAITER_PERMISSIONS]));

    const loaded = loadSession();
    const enumSet = permissionsForRole(CASHIER);

    // Negative: the enum fallback carries SALE_READ, which the API refuses a
    // waiter. If it leaks in, the rail offers a screen that 403s.
    expect(enumSet).toContain(Permission.SALE_READ);
    expect(loaded?.user.permissions).not.toContain(Permission.SALE_READ);
    expect(loaded?.user.permissions).not.toEqual(enumSet);
  });

  it('falls back to the enum role only when the stored session has no permissions', () => {
    // A session written before the server sent `permissions` at all.
    saveSession(waiterSession(undefined));
    expect(loadSession()?.user.permissions).toEqual(permissionsForRole(CASHIER));

    saveSession(waiterSession([]));
    expect(loadSession()?.user.permissions).toEqual(permissionsForRole(CASHIER));
  });

  it('drops a session from the removed offline demo mode', () => {
    saveSession({ ...waiterSession([...WAITER_PERMISSIONS]), token: 'mock.token' });

    expect(loadSession()).toBeNull();
    expect(window.localStorage.getItem('hpos.session')).toBeNull();
  });

  /*
   * MUTATION PROOF (D30) — the three mutations that would reintroduce the bug,
   * each shown to fail at least one assertion above. Written inline because a
   * green test here is otherwise indistinguishable from the defect: the
   * pre-fix code also "loaded a session with permissions", just the wrong ones.
   */
  describe('mutation proofs', () => {
    const stored = [...WAITER_PERMISSIONS];
    const enumSet = permissionsForRole(CASHIER);

    it('M1: unconditional re-derivation (the original defect) fails', () => {
      const mutated = enumSet; // parsed.user.permissions = permissionsForRole(role)
      expect(mutated).not.toEqual(stored);
      expect(mutated).toContain(Permission.SALE_READ);
      expect(mutated).not.toContain(Permission.ORDER_SEND_TO_KITCHEN);
    });

    it('M2: merging both sets instead of choosing fails', () => {
      const mutated = [...new Set([...stored, ...enumSet])];
      expect(mutated).not.toEqual(stored);
      expect(mutated).toContain(Permission.SALE_READ); // the leak the fix prevents
    });

    it('M3: an inverted guard (fall back when permissions EXIST) fails', () => {
      const mutated = stored.length > 0 ? enumSet : stored;
      expect(mutated).not.toEqual(stored);
      expect(mutated).toContain(Permission.SALE_READ);
    });
  });
});
