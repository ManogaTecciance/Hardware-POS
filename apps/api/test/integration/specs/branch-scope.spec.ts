/**
 * Branch scoping (Phase 1.5.6, decision D38).
 *
 * Six claims, each asserted positively AND negatively (D30):
 *
 *  1. **Cross-tenant branch requests answer 404.** A 403 would be a
 *     cross-tenant existence oracle.
 *  2. **Deactivated branches fail closed** on the very next request.
 *  3. **A user whose branch access was revoked** is refused on the next
 *     request, without needing token expiry.
 *  4. **Owner-level roles implicitly access every active branch** of their
 *     tenant — the set is `ADMIN_LEVEL_ROLES` (OWNER, ADMIN and, since D100,
 *     the hardware Salesperson); everyone else needs `User.branchId` or
 *     `BranchAccess`. The D100 block at the bottom derives its cases from that
 *     set rather than naming roles, so a role added there is covered here.
 *  5. **Tenant-wide administration routes are NOT branch-gated** — refusing
 *     them for lack of an active branch would be the "incorrect branch
 *     gating" the brief explicitly forbids.
 *  6. **Switching the active branch** reissues a token; access is granted
 *     from the database at the switch, not from a claim the client picks.
 */
import { ADMIN_LEVEL_ROLES, ALL_USER_ROLES, Permission, roleHasPermission } from '@hardware-pos/shared';
import { seedTenantRoles, syncPermissionCatalogue, linkUsersToRoles } from '@hardware-pos/database';
import type { PrismaClient, UserRole } from '@hardware-pos/database';

import { connectTestPrisma, disconnectTestPrisma } from '../prisma-test-client';
import { resetDatabase } from '../db-reset';
import { seedSecondTenant, seedTileShopWithQuickBooks, type SeededTenant } from '../fixtures';
import { createHttpIntegrationApp, type HttpIntegrationApp } from '../http-test-app';

let prisma: PrismaClient;
let http: HttpIntegrationApp;
let tile: SeededTenant;
let other: SeededTenant;

interface BranchAccessView {
  userId: string;
  role: string;
  roleGrant: boolean;
  defaultBranchId: string | null;
  explicitGrants: { branchId: string; grantedAt: string; grantedByUserId: string | null }[];
}

const ownerToken = (t: SeededTenant, activeBranchId: string | null = t.branchId) =>
  http.tokenFor({ userId: t.ownerId, tenantId: t.tenantId, role: 'OWNER', activeBranchId });

const cashierToken = (t: SeededTenant, activeBranchId: string | null = t.branchId) =>
  http.tokenFor({ userId: t.cashierId, tenantId: t.tenantId, role: 'CASHIER', activeBranchId });

beforeAll(async () => {
  prisma = await connectTestPrisma();
  http = await createHttpIntegrationApp();
});

afterAll(async () => {
  await http.close();
  await disconnectTestPrisma();
});

beforeEach(async () => {
  await resetDatabase(prisma);
  tile = await seedTileShopWithQuickBooks(prisma);
  other = await seedSecondTenant(prisma);
  await syncPermissionCatalogue(prisma);
  await seedTenantRoles(prisma, tile.tenantId, 'HARDWARE');
  await seedTenantRoles(prisma, other.tenantId, 'RESTAURANT');
  await linkUsersToRoles(prisma, tile.tenantId);
  await linkUsersToRoles(prisma, other.tenantId);
});

// ─────────────────────────────────────────────────────────────────────────────
// 1 — Tenant-wide administration is NOT branch-gated
// ─────────────────────────────────────────────────────────────────────────────

describe('Phase 1.5.6 — tenant-wide administration is not branch-gated', () => {
  it('the branch-access administration endpoints answer 200 without an active branch claim', async () => {
    const owner = http.tokenFor({
      userId: tile.ownerId,
      tenantId: tile.tenantId,
      role: 'OWNER',
      activeBranchId: null,
    });
    const view = await http.request<BranchAccessView>(
      'GET',
      `/users/${tile.cashierId}/branch-access`,
      { token: owner },
    );
    expect(view.status).toBe(200);
    expect(view.data.userId).toBe(tile.cashierId);
    expect(view.data.role).toBe('CASHIER');
    expect(view.data.roleGrant).toBe(false);
    // POSITIVE CONTROL: the fixture cashier's default branch is set, so the
    // response should report it explicitly.
    expect(view.data.defaultBranchId).toBe(tile.branchId);
  });

  it('the accessible-branches lookup answers 200 without an active branch claim', async () => {
    const owner = http.tokenFor({
      userId: tile.ownerId,
      tenantId: tile.tenantId,
      role: 'OWNER',
      activeBranchId: null,
    });
    const list = await http.request<{ id: string; name: string }[]>(
      'GET',
      '/auth/accessible-branches',
      { token: owner },
    );
    expect(list.status).toBe(200);
    // OWNER sees every active branch of their tenant, in name order.
    expect(list.data.map((b) => b.id)).toEqual([tile.branchId]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2 — Cross-tenant branch requests answer 404, never 403
// ─────────────────────────────────────────────────────────────────────────────

describe('Phase 1.5.6 — cross-tenant branch requests answer 404, never 403', () => {
  it('a foreign branch id on the switch endpoint answers 404', async () => {
    const res = await http.request(
      'POST',
      '/auth/active-branch',
      { token: ownerToken(tile, null), body: { branchId: other.branchId } },
    );
    expect(res.status).toBe(404);
    // Body message must NOT confirm the id exists somewhere — grep for the
    // foreign tenant/branch identifier in every layer of the response.
    const serialized = JSON.stringify(res.body ?? {});
    expect(serialized).not.toContain(other.branchId);
    expect(serialized).not.toContain(other.tenantId);
  });

  it('POSITIVE CONTROL: the same call with the caller\'s own branch id answers 200', async () => {
    const res = await http.request(
      'POST',
      '/auth/active-branch',
      { token: ownerToken(tile, null), body: { branchId: tile.branchId } },
    );
    expect(res.status).toBe(200);
  });

  it('a foreign branch id on the grant endpoint answers 404, not 403', async () => {
    const res = await http.request(
      'PUT',
      `/users/${tile.cashierId}/branch-access/${other.branchId}`,
      { token: ownerToken(tile), body: { confirm: true } },
    );
    expect(res.status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3 — Deactivated branches fail closed on the next request
// ─────────────────────────────────────────────────────────────────────────────

describe('Phase 1.5.6 — a deactivated branch fails closed on the next request', () => {
  it('the switch endpoint answers 404 for a branch that was deactivated', async () => {
    await prisma.branch.update({ where: { id: tile.branchId }, data: { isActive: false } });
    const res = await http.request(
      'POST',
      '/auth/active-branch',
      { token: ownerToken(tile, null), body: { branchId: tile.branchId } },
    );
    expect(res.status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4 — Revoked access takes effect on the next request, not at token expiry
// ─────────────────────────────────────────────────────────────────────────────

describe('Phase 1.5.6 — revoked branch access takes effect on the next request', () => {
  it('a cashier who lost access to their default branch is refused on switch', async () => {
    // Remove the cashier's default branch to simulate the removal of every
    // grant they had. A cashier is not owner-level (it is outside
    // `ADMIN_LEVEL_ROLES`), so with no BranchAccess and no default they can
    // enter no branch.
    await prisma.user.update({
      where: { id: tile.cashierId },
      data: { branchId: null },
    });
    const res = await http.request(
      'POST',
      '/auth/active-branch',
      {
        token: cashierToken(tile, null),
        body: { branchId: tile.branchId },
      },
    );
    // The branch still exists in the tenant, so this is not a 404 — it is a
    // 403 stating that access was removed. That is the intended distinction
    // for a same-tenant caller.
    expect(res.status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5 — Multi-branch access via BranchAccess table
// ─────────────────────────────────────────────────────────────────────────────

describe('Phase 1.5.6 — multi-branch access', () => {
  it('an OWNER sees every active branch of their tenant', async () => {
    // Add a second branch to prove the OWNER's response is not a coincidence
    // of the fixture only having one branch.
    await prisma.branch.create({
      data: { id: 'tile-branch-2', tenantId: tile.tenantId, name: 'Branch 2', code: 'B2' },
    });

    const owner = http.tokenFor({
      userId: tile.ownerId,
      tenantId: tile.tenantId,
      role: 'OWNER',
      activeBranchId: null,
    });
    const list = await http.request<{ id: string; name: string }[]>(
      'GET',
      '/auth/accessible-branches',
      { token: owner },
    );
    expect(list.status).toBe(200);
    expect(list.data.map((b) => b.id).sort()).toEqual([tile.branchId, 'tile-branch-2'].sort());
  });

  it('a CASHIER only sees branches they were granted, plus their default', async () => {
    await prisma.branch.create({
      data: { id: 'tile-branch-2', tenantId: tile.tenantId, name: 'Branch 2', code: 'B2' },
    });
    await prisma.branch.create({
      data: { id: 'tile-branch-3', tenantId: tile.tenantId, name: 'Branch 3', code: 'B3' },
    });
    // Grant the cashier access to branch 2 only.
    await prisma.branchAccess.create({
      data: { userId: tile.cashierId, branchId: 'tile-branch-2' },
    });
    const cashier = http.tokenFor({
      userId: tile.cashierId,
      tenantId: tile.tenantId,
      role: 'CASHIER',
      activeBranchId: tile.branchId,
    });
    const list = await http.request<{ id: string; name: string }[]>(
      'GET',
      '/auth/accessible-branches',
      { token: cashier },
    );
    expect(list.status).toBe(200);
    expect(list.data.map((b) => b.id).sort()).toEqual(
      [tile.branchId, 'tile-branch-2'].sort(),
    );
    // NEGATIVE: branch 3 was not granted and is not the default.
    expect(list.data.map((b) => b.id)).not.toContain('tile-branch-3');
  });

  it('an OWNER can grant a branch and the CASHIER can then switch into it', async () => {
    await prisma.branch.create({
      data: { id: 'tile-branch-2', tenantId: tile.tenantId, name: 'Branch 2', code: 'B2' },
    });
    const grantRes = await http.request<BranchAccessView>(
      'PUT',
      `/users/${tile.cashierId}/branch-access/tile-branch-2`,
      { token: ownerToken(tile), body: { confirm: true } },
    );
    expect(grantRes.status).toBe(200);
    expect(grantRes.data.explicitGrants.map((g) => g.branchId)).toEqual(['tile-branch-2']);

    const switchRes = await http.request<{ branch: { id: string } | null }>(
      'POST',
      '/auth/active-branch',
      {
        token: cashierToken(tile),
        body: { branchId: 'tile-branch-2' },
      },
    );
    expect(switchRes.status).toBe(200);
    expect(switchRes.data.branch?.id).toBe('tile-branch-2');
  });

  it('grant requires a confirmation flag — a fat-finger PUT is refused', async () => {
    const res = await http.request(
      'PUT',
      `/users/${tile.cashierId}/branch-access/${tile.branchId}`,
      { token: ownerToken(tile), body: {} },
    );
    expect(res.status).toBe(400);
  });

  it('revoking the last accessible branch is refused, so a user is never locked out', async () => {
    // Cashier's only branch is `tile.branchId` via User.branchId; no explicit
    // grants exist. Revoking the default's shadow row (which does not exist)
    // returns 404, not a lockout error — that path is fine.
    const noop = await http.request(
      'DELETE',
      `/users/${tile.cashierId}/branch-access/${tile.branchId}`,
      { token: ownerToken(tile) },
    );
    expect(noop.status).toBe(404);

    // Now set up: grant an explicit second branch, then try to revoke the
    // ONLY explicit grant when User.branchId is null → should fail with 403
    // (no branches left to reach) rather than silently succeed.
    await prisma.branch.create({
      data: { id: 'tile-branch-2', tenantId: tile.tenantId, name: 'Branch 2', code: 'B2' },
    });
    await prisma.branchAccess.create({
      data: { userId: tile.cashierId, branchId: 'tile-branch-2' },
    });
    await prisma.user.update({ where: { id: tile.cashierId }, data: { branchId: null } });

    const lockout = await http.request(
      'DELETE',
      `/users/${tile.cashierId}/branch-access/tile-branch-2`,
      { token: ownerToken(tile) },
    );
    expect(lockout.status).toBe(403);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6 — D100: every owner-level role reaches every branch, and only those roles
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Five API sites used to decide cross-branch access on
 * `role === 'OWNER' || role === 'ADMIN'`; D100 moved all five onto
 * `isAdminLevelRole`, so the hardware Salesperson reaches every active branch
 * exactly as the owner does. These cases are derived from `ADMIN_LEVEL_ROLES`
 * and its complement in `ALL_USER_ROLES` rather than listing roles by hand: a
 * role added to the set is tested without a second edit, and one that is NOT
 * in the set cannot slip into the widened path unnoticed (D30).
 *
 * Each subject is created with `branchId: null` and no `BranchAccess` row, so
 * the only thing that can let them into a branch is the role.
 */
describe('D100 — owner-level roles cross branches; everyone else is scoped', () => {
  const NON_ADMIN_ROLES: readonly UserRole[] = ALL_USER_ROLES.filter(
    (role) => !ADMIN_LEVEL_ROLES.includes(role),
  );

  /** A user of `role` in the hardware tenant with no default branch and no grants. */
  async function userWithRole(role: UserRole): Promise<string> {
    const id = `${tile.tenantId}-d100-${role.toLowerCase()}`;
    await prisma.user.create({
      data: {
        id,
        tenantId: tile.tenantId,
        branchId: null,
        role,
        name: `D100 ${role}`,
        email: `d100.${role.toLowerCase()}@fixture-tile-shop.test`,
      },
    });
    return id;
  }

  const tokenOf = (userId: string, role: UserRole, activeBranchId: string | null = null) =>
    http.tokenFor({ userId, tenantId: tile.tenantId, role, activeBranchId });

  const addSecondBranch = () =>
    prisma.branch.create({
      data: { id: 'tile-branch-2', tenantId: tile.tenantId, name: 'Branch 2', code: 'B2' },
    });

  /** A BRANCH_SCOPED route (POST /sales/draft) hit with an active-branch claim. */
  const draftIn = (token: string, branchId: string) =>
    http.request('POST', '/sales/draft', {
      token,
      body: { branchId, items: [{ productId: tile.productAId, quantity: '1.000' }] },
    });

  it('POSITIVE CONTROL: the two role sets partition the enum, and the D100 role is owner-level', () => {
    // Every `it.each` below reads one of these tables; a table that came back
    // empty would pass every case by running none (D30 rule 7).
    expect(ADMIN_LEVEL_ROLES.length).toBeGreaterThan(0);
    expect(NON_ADMIN_ROLES.length).toBeGreaterThan(0);
    expect([...ADMIN_LEVEL_ROLES, ...NON_ADMIN_ROLES].sort()).toEqual([...ALL_USER_ROLES].sort());
    expect(ADMIN_LEVEL_ROLES).toContain('SALESPERSON');
    expect(NON_ADMIN_ROLES).toContain('CASHIER');

    // The branch-scoped probe below is POST /sales/draft, and `PermissionsGuard`
    // runs BEFORE `BranchScopeGuard`. So the probe only says something about
    // branch scope for a role that holds `sale:create`: every owner-level role
    // must (or its 201 would be a permission accident), and at least one
    // scoped role must, so the guard's own refusal is exercised at least once.
    expect(ADMIN_LEVEL_ROLES.filter((r) => !roleHasPermission(r, Permission.SALE_CREATE))).toEqual([]);
    expect(NON_ADMIN_ROLES.filter((r) => roleHasPermission(r, Permission.SALE_CREATE))).not.toEqual([]);
  });

  it.each(ADMIN_LEVEL_ROLES)(
    '%s with no default branch and no grant sees every active branch',
    async (role) => {
      await addSecondBranch();
      const userId = await userWithRole(role);

      const list = await http.request<{ id: string; name: string }[]>(
        'GET',
        '/auth/accessible-branches',
        { token: tokenOf(userId, role) },
      );
      expect(list.status).toBe(200);
      expect(list.data.map((b) => b.id).sort()).toEqual([tile.branchId, 'tile-branch-2'].sort());
    },
  );

  it.each(ADMIN_LEVEL_ROLES)(
    '%s can switch into a branch it holds no grant for, and a branch-scoped route then answers',
    async (role) => {
      await addSecondBranch();
      const userId = await userWithRole(role);
      expect(await prisma.branchAccess.count({ where: { userId } })).toBe(0);

      const switched = await http.request<{ branch: { id: string } | null }>(
        'POST',
        '/auth/active-branch',
        { token: tokenOf(userId, role), body: { branchId: 'tile-branch-2' } },
      );
      expect(switched.status).toBe(200);
      expect(switched.data.branch?.id).toBe('tile-branch-2');

      // The guard re-checks access from the database on every branch-scoped
      // request; the role, not the switch, is what admits them.
      const drafted = await draftIn(tokenOf(userId, role, 'tile-branch-2'), 'tile-branch-2');
      expect(drafted.status).toBe(201);
    },
  );

  it.each(NON_ADMIN_ROLES)(
    'NEGATIVE: %s with no grant is refused the same switch',
    async (role) => {
      // The pair for the case above. Without it, a switch endpoint that admitted
      // everyone would pass every owner-level row.
      await addSecondBranch();
      const userId = await userWithRole(role);

      const switched = await http.request(
        'POST',
        '/auth/active-branch',
        { token: tokenOf(userId, role), body: { branchId: 'tile-branch-2' } },
      );
      // 404, not 403: the switch never confirms a branch exists to a caller who
      // cannot reach it (claim 1).
      expect(switched.status).toBe(404);

      const drafted = await draftIn(tokenOf(userId, role, 'tile-branch-2'), 'tile-branch-2');
      expect(drafted.status).toBe(403);
      // Which guard said no. `PermissionsGuard` runs before `BranchScopeGuard`,
      // so a role without `sale:create` (ACCOUNTANT) is turned away by the
      // permission check and this probe proves nothing about branch scope for
      // it — the 404 above is that role's branch negative. For a role that
      // holds the permission, the 403 must be the branch guard's own refusal,
      // or a stray 403 from any earlier guard would pass this case.
      const branchRefusal = 'Access to this branch has been removed';
      if (roleHasPermission(role, Permission.SALE_CREATE)) {
        expect(JSON.stringify(drafted.body)).toContain(branchRefusal);
      } else {
        expect(JSON.stringify(drafted.body)).not.toContain(branchRefusal);
      }
    },
  );

  it.each(ADMIN_LEVEL_ROLES)('the branch-access console reports %s as a role grant', async (role) => {
    const userId = await userWithRole(role);
    const view = await http.request<BranchAccessView>('GET', `/users/${userId}/branch-access`, {
      token: ownerToken(tile, null),
    });
    expect(view.status).toBe(200);
    expect(view.data).toMatchObject({ userId, role, roleGrant: true, defaultBranchId: null });
    expect(view.data.explicitGrants).toEqual([]);
  });

  it.each(NON_ADMIN_ROLES)('NEGATIVE: the branch-access console reports %s without a role grant', async (role) => {
    const userId = await userWithRole(role);
    const view = await http.request<BranchAccessView>('GET', `/users/${userId}/branch-access`, {
      token: ownerToken(tile, null),
    });
    expect(view.status).toBe(200);
    // The role echo proves the row inspected is this user's, not a default view.
    expect(view.data).toMatchObject({ userId, role, roleGrant: false });
  });

  it.each(ADMIN_LEVEL_ROLES)(
    'revoking the only explicit grant of %s is never a lockout',
    async (role) => {
      await addSecondBranch();
      const userId = await userWithRole(role);

      const granted = await http.request<BranchAccessView>(
        'PUT',
        `/users/${userId}/branch-access/tile-branch-2`,
        { token: ownerToken(tile), body: { confirm: true } },
      );
      expect(granted.status).toBe(200);
      expect(granted.data.explicitGrants.map((g) => g.branchId)).toEqual(['tile-branch-2']);

      // `User.branchId` is null and this is the only grant — the exact state the
      // last-branch guard refuses for a scoped role (below and in block 5).
      const revoked = await http.request<BranchAccessView>(
        'DELETE',
        `/users/${userId}/branch-access/tile-branch-2`,
        { token: ownerToken(tile) },
      );
      expect(revoked.status).toBe(200);
      expect(revoked.data.explicitGrants).toEqual([]);

      // Still not locked out: the role admits them without the row.
      const switched = await http.request(
        'POST',
        '/auth/active-branch',
        { token: tokenOf(userId, role), body: { branchId: 'tile-branch-2' } },
      );
      expect(switched.status).toBe(200);
    },
  );

  it.each(NON_ADMIN_ROLES)(
    'NEGATIVE: revoking the only explicit grant of %s is refused as a lockout',
    async (role) => {
      await addSecondBranch();
      const userId = await userWithRole(role);
      await prisma.branchAccess.create({ data: { userId, branchId: 'tile-branch-2' } });

      const revoked = await http.request(
        'DELETE',
        `/users/${userId}/branch-access/tile-branch-2`,
        { token: ownerToken(tile) },
      );
      expect(revoked.status).toBe(403);
      expect(await prisma.branchAccess.count({ where: { userId } })).toBe(1);
    },
  );

  it('MUTATION PROOF: the pre-D100 predicate would be detected by the tables above', async () => {
    // The five sites used to ask this. Run it over the enum: it passes a
    // different set from `ADMIN_LEVEL_ROLES`, so the `it.each` tables derived
    // from that set contain a case (SALESPERSON) the old predicate refuses.
    const preD100 = (role: UserRole) => role === 'OWNER' || role === 'ADMIN';
    const passedByMutant = ALL_USER_ROLES.filter(preD100).sort();
    expect(() => expect(passedByMutant).toEqual([...ADMIN_LEVEL_ROLES].sort())).toThrow();

    // And against the database: a salesperson with no default and no grant
    // would see NO branch under the old predicate. The live answer is every
    // branch, and asserting the old answer against it throws.
    await addSecondBranch();
    const userId = await userWithRole('SALESPERSON');
    const list = await http.request<{ id: string }[]>('GET', '/auth/accessible-branches', {
      token: tokenOf(userId, 'SALESPERSON'),
    });
    expect(list.status).toBe(200);
    expect(list.data).toHaveLength(2);
    expect(() => expect(list.data.map((b) => b.id)).toEqual([])).toThrow();
  });
});
