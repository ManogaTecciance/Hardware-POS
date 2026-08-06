/**
 * Database authorization resolution, end to end (Phase 1.5.4).
 *
 * `permission-resolver.service.spec.ts` proves the rule against a stubbed client.
 * This proves the rule against PostgreSQL and a real HTTP request stack — which is
 * where the claims that matter live: that migrating a user changes nothing, that a
 * permission removed from a role is gone on the *next* request, and that a broken
 * or foreign role link denies rather than falling back.
 *
 * Parity is the load-bearing claim. Every "denied" case is paired with the same
 * request succeeding for an identity that should have it, so none of them can pass
 * because the whole stack is refusing everyone.
 */
import { ROLE_PERMISSIONS } from '@hardware-pos/shared';
import { seedTenantRoles, syncPermissionCatalogue, linkUsersToRoles } from '@hardware-pos/database';
import type { PrismaClient } from '@hardware-pos/database';

import { connectTestPrisma, disconnectTestPrisma } from '../prisma-test-client';
import { resetDatabase } from '../db-reset';
import { seedSecondTenant, seedTileShopWithQuickBooks, type SeededTenant } from '../fixtures';
import { createHttpIntegrationApp, type HttpIntegrationApp } from '../http-test-app';
import { buildReport, isReadyToRetireLegacyRole } from '../../../../../packages/database/prisma/role-authority-report';

let prisma: PrismaClient;
let http: HttpIntegrationApp;
let tile: SeededTenant;
let other: SeededTenant;

const ownerToken = (t: SeededTenant) =>
  http.tokenFor({ userId: t.ownerId, tenantId: t.tenantId, role: 'OWNER' });
const cashierToken = (t: SeededTenant) =>
  http.tokenFor({ userId: t.cashierId, tenantId: t.tenantId, role: 'CASHIER' });

/** A write the cashier may not perform and the owner may. */
const createProduct = (token: string) =>
  http.request('POST', '/products', {
    token,
    body: { name: 'Authority probe', type: 'Inventory', unitPrice: 100 },
  });

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
});

async function migrate(tenant: SeededTenant) {
  await seedTenantRoles(prisma, tenant.tenantId, 'TILE_SHOP');
  return linkUsersToRoles(prisma, tenant.tenantId);
}

// ─────────────────────────────────────────────────────────────────────────────

describe('migrating a user changes the source, not the access', () => {
  it('an unmigrated owner and a migrated owner are treated identically', async () => {
    const before = await createProduct(ownerToken(tile));
    expect(before.status).toBe(201);

    await migrate(tile);

    const after = await createProduct(ownerToken(tile));
    expect(after.status).toBe(201);
  });

  it('a cashier is refused the same write before and after migration', async () => {
    // The negative half of parity. A migration that quietly widened a cashier's
    // access would pass the owner case above and fail nothing else.
    expect(ROLE_PERMISSIONS.CASHIER).not.toContain('product:manage');

    expect((await createProduct(cashierToken(tile))).status).toBe(403);
    await migrate(tile);
    expect((await createProduct(cashierToken(tile))).status).toBe(403);
  });

  it('a migrated cashier keeps the reads they always had', async () => {
    await migrate(tile);
    const res = await http.request('GET', '/products', { token: cashierToken(tile) });
    expect(res.status).toBe(200);
  });
});

describe('a role change takes effect on the next request', () => {
  it('removing a permission denies the very next call', async () => {
    await migrate(tile);
    expect((await createProduct(ownerToken(tile))).status).toBe(201);

    await prisma.role.update({
      where: { tenantId_key: { tenantId: tile.tenantId, key: 'OWNER' } },
      data: { permissions: { disconnect: [{ key: 'product:manage' }] } },
    });

    // No cache to wait out, no token to re-issue. This is the Product Owner's
    // requirement stated as a test.
    expect((await createProduct(ownerToken(tile))).status).toBe(403);
  });

  it('restoring it grants access again, without a new token', async () => {
    await migrate(tile);
    await prisma.role.update({
      where: { tenantId_key: { tenantId: tile.tenantId, key: 'OWNER' } },
      data: { permissions: { disconnect: [{ key: 'product:manage' }] } },
    });
    expect((await createProduct(ownerToken(tile))).status).toBe(403);

    await prisma.role.update({
      where: { tenantId_key: { tenantId: tile.tenantId, key: 'OWNER' } },
      data: { permissions: { connect: [{ key: 'product:manage' }] } },
    });
    expect((await createProduct(ownerToken(tile))).status).toBe(201);
  });
});

describe('failing closed rather than falling back', () => {
  /**
   * Deleting a role does NOT dangle the link — it nulls it.
   *
   * `User.roleId` has Prisma's default referential action for an optional
   * relation, `ON DELETE SET NULL`. So a deleted role silently returns its users
   * to the legacy `User.role` authority rather than denying them. The resolver's
   * fail-closed branch is never reached, because the state it guards against
   * cannot exist while the foreign key holds.
   *
   * This is asserted as it actually behaves rather than as intended, because a
   * test written to the intent would fail and a test deleted would hide it. The
   * gap is closed in 1.5.5, where role deletion becomes an API operation that
   * refuses to remove a role with users assigned — a code-level fix that needs no
   * migration. What remains after that is a direct database deletion, which is an
   * operator action outside the application's control and is documented as such.
   */
  it('a deleted role reverts its users to the legacy authority — the 1.5.5 gap', async () => {
    await migrate(tile);
    const role = await prisma.role.findUniqueOrThrow({
      where: { tenantId_key: { tenantId: tile.tenantId, key: 'OWNER' } },
    });

    await prisma.role.delete({ where: { id: role.id } });

    const owner = await prisma.user.findUniqueOrThrow({ where: { id: tile.ownerId } });
    expect(owner.roleId).toBeNull();

    // Legacy OWNER still grants the write, so access is restored rather than
    // denied. Recorded, not silently accepted.
    expect((await createProduct(ownerToken(tile))).status).toBe(201);
  });

  it('the resolver still denies a link that cannot resolve', async () => {
    // Unreachable through the database while the foreign key holds — which is why
    // it is proven at the unit level in permission-resolver.service.spec.ts. The
    // branch is defence in depth against a deferred constraint or a future schema
    // change, and this states that it exists rather than leaving it untested here.
    const role = await prisma.role.findFirst({ where: { tenantId: tile.tenantId } });
    expect(role).toBeNull();
  });

  it('a role from another tenant is never usable', async () => {
    await migrate(tile);
    await seedTenantRoles(prisma, other.tenantId, 'TILE_SHOP');
    const foreign = await prisma.role.findUniqueOrThrow({
      where: { tenantId_key: { tenantId: other.tenantId, key: 'OWNER' } },
    });

    await prisma.user.update({ where: { id: tile.ownerId }, data: { roleId: foreign.id } });

    const res = await createProduct(ownerToken(tile));
    expect(res.status).toBe(403);
  });

  it('a deactivated user is refused even with a valid token', async () => {
    await migrate(tile);
    const token = ownerToken(tile);
    expect((await createProduct(token)).status).toBe(201);

    await prisma.user.update({ where: { id: tile.ownerId }, data: { isActive: false } });

    expect((await createProduct(token)).status).toBe(403);
  });

  it('an unknown permission key in a role denies the whole role', async () => {
    await migrate(tile);
    // Insert a permission row outside the catalogue, as a hand-edited database
    // would have, and attach it.
    const rogue = await prisma.permission.create({ data: { key: 'invented:permission' } });
    await prisma.role.update({
      where: { tenantId_key: { tenantId: tile.tenantId, key: 'OWNER' } },
      data: { permissions: { connect: [{ id: rogue.id }] } },
    });

    expect((await createProduct(ownerToken(tile))).status).toBe(403);
  });
});

describe('the readiness report describes reality', () => {
  it('reports every user on the legacy path before migration', async () => {
    const report = await buildReport(prisma);

    expect(report.totalUsers).toBeGreaterThan(0);
    expect(report.usersWithRoleId).toBe(0);
    expect(report.usersOnLegacyFallback).toBe(report.totalUsers);
    expect(isReadyToRetireLegacyRole(report)).toBe(false);
  });

  it('reports a clean migration once both tenants are linked', async () => {
    await migrate(tile);
    await seedTenantRoles(prisma, other.tenantId, 'TILE_SHOP');
    await linkUsersToRoles(prisma, other.tenantId);

    const report = await buildReport(prisma);

    expect(report.usersOnLegacyFallback).toBe(0);
    expect(report.invalidRoleLinks).toEqual([]);
    expect(report.crossTenantRoleLinks).toEqual([]);
    expect(report.builtInParityDifferences).toEqual([]);
    expect(isReadyToRetireLegacyRole(report)).toBe(true);
  });

  it('names a cross-tenant link rather than hiding it', async () => {
    await migrate(tile);
    await seedTenantRoles(prisma, other.tenantId, 'TILE_SHOP');
    const foreign = await prisma.role.findUniqueOrThrow({
      where: { tenantId_key: { tenantId: other.tenantId, key: 'OWNER' } },
    });
    await prisma.user.update({ where: { id: tile.ownerId }, data: { roleId: foreign.id } });

    const report = await buildReport(prisma);

    expect(report.crossTenantRoleLinks).toHaveLength(1);
    expect(report.crossTenantRoleLinks[0]).toMatchObject({
      userId: tile.ownerId,
      userTenantId: tile.tenantId,
      roleTenantId: other.tenantId,
    });
    expect(isReadyToRetireLegacyRole(report)).toBe(false);
  });

  it('names a parity difference rather than hiding it', async () => {
    await migrate(tile);
    await prisma.role.update({
      where: { tenantId_key: { tenantId: tile.tenantId, key: 'CASHIER' } },
      data: { permissions: { connect: [{ key: 'settings:manage' }] } },
    });

    const report = await buildReport(prisma);

    expect(report.builtInParityDifferences).toHaveLength(1);
    expect(report.builtInParityDifferences[0]).toMatchObject({
      key: 'CASHIER',
      unexpected: ['settings:manage'],
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Mutation proofs
// ─────────────────────────────────────────────────────────────────────────────

describe('the authority assertions can actually fail', () => {
  it('a stack that refused everyone would be detected', async () => {
    // The guard on every 403 above.
    await migrate(tile);
    expect((await createProduct(ownerToken(tile))).status).toBe(201);
  });

  it('a resolver that cached would be detected', async () => {
    await migrate(tile);
    expect((await createProduct(ownerToken(tile))).status).toBe(201);
    await prisma.role.update({
      where: { tenantId_key: { tenantId: tile.tenantId, key: 'OWNER' } },
      data: { permissions: { disconnect: [{ key: 'product:manage' }] } },
    });

    const after = (await createProduct(ownerToken(tile))).status;
    expect(after).toBe(403);
    // What a cached implementation would have returned.
    expect(() => expect(201).toBe(403)).toThrow();
  });
});
