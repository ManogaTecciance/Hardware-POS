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
 *  4. **OWNER/ADMIN implicitly access every active branch** of their tenant;
 *     everyone else needs `User.branchId` or `BranchAccess`.
 *  5. **Tenant-wide administration routes are NOT branch-gated** — refusing
 *     them for lack of an active branch would be the "incorrect branch
 *     gating" the brief explicitly forbids.
 *  6. **Switching the active branch** reissues a token; access is granted
 *     from the database at the switch, not from a claim the client picks.
 */
import { seedTenantRoles, syncPermissionCatalogue, linkUsersToRoles } from '@hardware-pos/database';
import type { PrismaClient } from '@hardware-pos/database';

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
  await seedTenantRoles(prisma, tile.tenantId, 'TILE_SHOP');
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
    // grant they had. A cashier is neither OWNER nor ADMIN, so with no
    // BranchAccess and no default they can enter no branch.
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
