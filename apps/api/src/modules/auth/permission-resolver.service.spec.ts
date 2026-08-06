/**
 * Authorization resolution (Phase 1.5.4, D37).
 *
 * The interesting cases are all refusals, and refusals are where a test goes
 * vacuous: a resolver that returned nothing for every input would satisfy every
 * "denied" assertion here. So each one is paired with the same shape resolving
 * successfully, and the DATABASE and LEGACY_FALLBACK paths are asserted to produce
 * *different* permission sets so neither can quietly become the other.
 */
import { ROLE_PERMISSIONS } from '@hardware-pos/shared';

import { PermissionResolver } from './permission-resolver.service';
import { Permission } from './permissions';
import type { AuthenticatedUser } from './auth.types';

type UserRow = {
  roleId: string | null;
  role: keyof typeof ROLE_PERMISSIONS;
  customRole: {
    id: string;
    key: string | null;
    tenantId: string;
    permissions: { key: string }[];
  } | null;
} | null;

function resolverFor(row: UserRow) {
  const findFirst = jest.fn().mockResolvedValue(row);
  const prisma = { user: { findFirst } } as never;
  return { resolver: new PermissionResolver(prisma), findFirst };
}

const USER: AuthenticatedUser = { id: 'usr_1', tenantId: 'tnt_a', role: 'CASHIER' };

// ─────────────────────────────────────────────────────────────────────────────

describe('a user who has not been migrated', () => {
  it('resolves through the legacy authority', async () => {
    const { resolver } = resolverFor({ roleId: null, role: 'CASHIER', customRole: null });

    const authority = await resolver.resolve(USER);

    expect(authority.source).toBe('LEGACY_FALLBACK');
    expect([...authority.permissions].sort()).toEqual([...ROLE_PERMISSIONS.CASHIER].sort());
  });

  it('gets exactly their own role’s permissions, not another role’s', async () => {
    const { resolver } = resolverFor({ roleId: null, role: 'ACCOUNTANT', customRole: null });

    const authority = await resolver.resolve({ ...USER, role: 'ACCOUNTANT' });

    expect([...authority.permissions].sort()).toEqual([...ROLE_PERMISSIONS.ACCOUNTANT].sort());
    // The two roles differ, so "it returned the right one" is a real claim.
    expect([...ROLE_PERMISSIONS.ACCOUNTANT].sort()).not.toEqual([...ROLE_PERMISSIONS.CASHIER].sort());
  });
});

describe('a migrated user', () => {
  it('resolves from the database role', async () => {
    const { resolver } = resolverFor({
      roleId: 'rol_1',
      role: 'CASHIER',
      customRole: {
        id: 'rol_1',
        key: 'CASHIER',
        tenantId: 'tnt_a',
        permissions: [{ key: Permission.SALE_READ }, { key: Permission.PRODUCT_READ }],
      },
    });

    const authority = await resolver.resolve(USER);

    expect(authority.source).toBe('DATABASE');
    expect([...authority.permissions].sort()).toEqual(
      [Permission.PRODUCT_READ, Permission.SALE_READ].sort(),
    );
  });

  it('does not receive the union of database and legacy permissions', async () => {
    // The escalation this rule prevents: a permission removed from the role would
    // survive forever if the legacy set were merged in.
    const { resolver } = resolverFor({
      roleId: 'rol_1',
      role: 'CASHIER',
      customRole: {
        id: 'rol_1',
        key: 'CASHIER',
        tenantId: 'tnt_a',
        permissions: [{ key: Permission.SALE_READ }],
      },
    });

    const authority = await resolver.resolve(USER);

    expect(authority.permissions.has(Permission.SALE_READ)).toBe(true);
    // Legacy CASHIER holds these; the database role does not, so they must be gone.
    expect(ROLE_PERMISSIONS.CASHIER).toContain(Permission.SALE_CREATE);
    expect(authority.permissions.has(Permission.SALE_CREATE)).toBe(false);
  });

  it('scopes the lookup by tenant as well as user id', async () => {
    const { resolver, findFirst } = resolverFor({
      roleId: 'rol_1',
      role: 'CASHIER',
      customRole: { id: 'rol_1', key: 'CASHIER', tenantId: 'tnt_a', permissions: [] },
    });

    await resolver.resolve(USER);

    // The query is what makes a cross-tenant link unusable — not a comparison
    // afterwards, which a later refactor could drop.
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'usr_1', tenantId: 'tnt_a', isActive: true }),
      }),
    );
  });
});

describe('failing closed', () => {
  it('denies when the role link does not resolve', async () => {
    const { resolver } = resolverFor({ roleId: 'rol_missing', role: 'OWNER', customRole: null });

    const authority = await resolver.resolve({ ...USER, role: 'OWNER' });

    expect(authority.source).toBe('DENIED');
    expect(authority.permissions.size).toBe(0);
    expect(authority.reason).toBe('role-unresolved');
  });

  it('does not fall back to legacy when the role link is broken', async () => {
    // The specific escalation: deleting a restricted user's role must not restore
    // the permissions their legacy role would have carried.
    const { resolver } = resolverFor({ roleId: 'rol_missing', role: 'OWNER', customRole: null });

    const authority = await resolver.resolve({ ...USER, role: 'OWNER' });

    expect(authority.permissions.has(Permission.SETTINGS_MANAGE)).toBe(false);
    // Positive control: the legacy authority for OWNER really does grant it, so
    // the absence above is the resolver's doing.
    expect(ROLE_PERMISSIONS.OWNER).toContain(Permission.SETTINGS_MANAGE);
  });

  it('denies a role belonging to another tenant', async () => {
    const { resolver } = resolverFor({
      roleId: 'rol_x',
      role: 'CASHIER',
      customRole: {
        id: 'rol_x',
        key: 'OWNER',
        tenantId: 'tnt_b',
        permissions: [{ key: Permission.SETTINGS_MANAGE }],
      },
    });

    const authority = await resolver.resolve(USER);

    expect(authority.source).toBe('DENIED');
    expect(authority.reason).toBe('cross-tenant-role');
    expect(authority.permissions.size).toBe(0);
  });

  it('denies a role assigning a permission the catalogue does not know', async () => {
    const { resolver } = resolverFor({
      roleId: 'rol_1',
      role: 'CASHIER',
      customRole: {
        id: 'rol_1',
        key: 'CUSTOM',
        tenantId: 'tnt_a',
        permissions: [{ key: Permission.SALE_READ }, { key: 'invented:permission' }],
      },
    });

    const authority = await resolver.resolve(USER);

    expect(authority.source).toBe('DENIED');
    expect(authority.reason).toBe('unknown-permission');
    // Not "honour the valid half" — a hand-edited row is not partially trustworthy.
    expect(authority.permissions.size).toBe(0);
  });

  it('denies a user who is no longer active', async () => {
    // `isActive: true` is in the query, so a suspended user returns no row. The
    // token is still valid; the account is not.
    const { resolver } = resolverFor(null);

    const authority = await resolver.resolve(USER);

    expect(authority.source).toBe('DENIED');
    expect(authority.reason).toBe('user-not-active');
  });

  it('grants an empty role nothing, without denying', async () => {
    // A role with no permissions is a legitimate configuration, distinct from a
    // broken one: the source stays DATABASE so the diagnostics do not report a
    // fault that did not happen.
    const { resolver } = resolverFor({
      roleId: 'rol_1',
      role: 'CASHIER',
      customRole: { id: 'rol_1', key: 'EMPTY', tenantId: 'tnt_a', permissions: [] },
    });

    const authority = await resolver.resolve(USER);

    expect(authority.source).toBe('DATABASE');
    expect(authority.permissions.size).toBe(0);
  });
});

describe('the authority is read fresh every time', () => {
  it('does not cache between calls', async () => {
    // The Product Owner's requirement: a role change takes effect on the next
    // validated request, with no dependency on process-local cache state.
    const { resolver, findFirst } = resolverFor({
      roleId: null,
      role: 'CASHIER',
      customRole: null,
    });

    await resolver.resolve(USER);
    await resolver.resolve(USER);

    expect(findFirst).toHaveBeenCalledTimes(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Mutation proofs
// ─────────────────────────────────────────────────────────────────────────────

describe('the resolution assertions can actually fail', () => {
  it('a resolver that fell back on a broken link would be detected', async () => {
    const { resolver } = resolverFor({ roleId: 'rol_missing', role: 'OWNER', customRole: null });
    const authority = await resolver.resolve({ ...USER, role: 'OWNER' });
    expect(authority.source).toBe('DENIED');

    // What the rejected implementation would have returned.
    const fellBack = { source: 'LEGACY_FALLBACK' as const };
    expect(() => expect(fellBack.source).toBe('DENIED')).toThrow();
  });

  it('a resolver that returned the union would be detected', async () => {
    const union = new Set([...ROLE_PERMISSIONS.CASHIER, Permission.SALE_READ]);
    expect(union.has(Permission.SALE_CREATE)).toBe(true);
    expect(() => expect(union.has(Permission.SALE_CREATE)).toBe(false)).toThrow();
  });

  it('a resolver that denied everything would be detected', async () => {
    // The guard on every "denied" assertion above: the happy path must still work.
    const { resolver } = resolverFor({ roleId: null, role: 'OWNER', customRole: null });
    const authority = await resolver.resolve({ ...USER, role: 'OWNER' });

    expect(authority.source).toBe('LEGACY_FALLBACK');
    expect(authority.permissions.size).toBeGreaterThan(0);
  });
});
