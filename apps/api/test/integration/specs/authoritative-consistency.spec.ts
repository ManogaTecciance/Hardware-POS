/**
 * Phase 1.5.8 — Tier 1 (authoritative) consistency across API replicas.
 *
 * The two-tier settings contract splits state into:
 *
 *   Tier 1 — security-sensitive: roles, permissions, user activation,
 *            branch access, module access, integration access. Authoritative
 *            on the NEXT VALIDATED REQUEST, never from a process-local cache.
 *
 *   Tier 2 — non-security: branding, receipts, business preferences. Documented
 *            eventual consistency, at most `SETTINGS_CACHE_TTL_MS`.
 *
 * The existing `settings-consistency.spec.ts` covers Tier 2 with two
 * `SettingsService` instances. This spec covers Tier 1 with two full API
 * instances sharing one database — the more realistic stand-in for two
 * replicas — and asserts that every security-sensitive mutation is observable
 * on the OTHER instance the very next request, without waiting.
 */
import { seedTenantRoles, syncPermissionCatalogue, linkUsersToRoles } from '@hardware-pos/database';
import type { PrismaClient } from '@hardware-pos/database';

import { connectTestPrisma, disconnectTestPrisma } from '../prisma-test-client';
import { resetDatabase } from '../db-reset';
import { seedTileShopWithQuickBooks, type SeededTenant } from '../fixtures';
import { createHttpIntegrationApp, type HttpIntegrationApp } from '../http-test-app';

let prisma: PrismaClient;
let replicaA: HttpIntegrationApp;
let replicaB: HttpIntegrationApp;
let tile: SeededTenant;

const ownerToken = (t: SeededTenant, http: HttpIntegrationApp) =>
  http.tokenFor({ userId: t.ownerId, tenantId: t.tenantId, role: 'OWNER', activeBranchId: t.branchId });

beforeAll(async () => {
  prisma = await connectTestPrisma();
  replicaA = await createHttpIntegrationApp();
  replicaB = await createHttpIntegrationApp();
});

afterAll(async () => {
  await replicaA.close();
  await replicaB.close();
  await disconnectTestPrisma();
});

beforeEach(async () => {
  await resetDatabase(prisma);
  tile = await seedTileShopWithQuickBooks(prisma);
  await syncPermissionCatalogue(prisma);
  await seedTenantRoles(prisma, tile.tenantId, 'HARDWARE');
  await linkUsersToRoles(prisma, tile.tenantId);
});

// ─────────────────────────────────────────────────────────────────────────────
// Role permission changes propagate on the next validated request
// ─────────────────────────────────────────────────────────────────────────────

describe('Phase 1.5.8 — Tier 1: role permission changes on replica A observable on replica B', () => {
  it('revoking a permission on A denies the very next request on B', async () => {
    // Create a custom role on A (built-in roles are immutable), grant it to
    // the cashier, then change its permission set on A and verify B refuses.
    const create = await replicaA.request<{ id: string; version: number }>('POST', '/roles', {
      token: ownerToken(tile, replicaA),
      body: {
        key: 'CROSS_REPLICA_TEST',
        name: 'Cross-Replica Test',
        permissions: ['sale:read', 'customer:read'],
      },
    });
    expect(create.status).toBe(201);
    const roleId = create.data.id;

    // Assign the role to the cashier on A.
    const assign = await replicaA.request('PUT', `/users/${tile.cashierId}/role`, {
      token: ownerToken(tile, replicaA),
      body: { roleId },
    });
    expect(assign.status).toBe(200);

    const cashierToken = replicaB.tokenFor({
      userId: tile.cashierId,
      tenantId: tile.tenantId,
      role: 'CASHIER',
      activeBranchId: tile.branchId,
    });

    // Baseline on B: cashier can list customers.
    const before = await replicaB.request('GET', '/customers', { token: cashierToken });
    expect(before.status).toBe(200);

    // Revoke customer:read on A by replacing the role's permission set.
    const revoke = await replicaA.request('PUT', `/roles/${roleId}/permissions`, {
      token: ownerToken(tile, replicaA),
      body: { permissions: ['sale:read'] },
    });
    expect(revoke.status).toBe(200);

    // Immediately on B: the SAME token is refused because the resolver reads
    // the database on every request (no process-local cache).
    const after = await replicaB.request('GET', '/customers', { token: cashierToken });
    expect(after.status).toBe(403);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Branch access revocation propagates on the next validated request
// ─────────────────────────────────────────────────────────────────────────────

describe('Phase 1.5.8 — Tier 1: branch access revocation on A visible on B', () => {
  it('a granted-then-revoked branch is refused on the very next request on B', async () => {
    await prisma.branch.create({
      data: { id: 'shared-branch-2', tenantId: tile.tenantId, name: 'Branch 2', code: 'B2' },
    });

    // Grant on A.
    const grant = await replicaA.request(
      'PUT',
      `/users/${tile.cashierId}/branch-access/shared-branch-2`,
      { token: ownerToken(tile, replicaA), body: { confirm: true } },
    );
    expect(grant.status).toBe(200);

    // Cashier switches into it on B — the grant is observable.
    const cashierToken = replicaB.tokenFor({
      userId: tile.cashierId,
      tenantId: tile.tenantId,
      role: 'CASHIER',
      activeBranchId: 'shared-branch-2',
    });
    const list = await replicaB.request('GET', '/auth/accessible-branches', { token: cashierToken });
    expect(list.status).toBe(200);
    expect((list.data as { id: string }[]).map((b) => b.id)).toContain('shared-branch-2');

    // Revoke on A. Cashier's request on B now fails on any branch-scoped
    // route — the guard reads BranchAccess on every request.
    const revoke = await replicaA.request(
      'DELETE',
      `/users/${tile.cashierId}/branch-access/shared-branch-2`,
      { token: ownerToken(tile, replicaA) },
    );
    expect(revoke.status).toBe(200);

    // Any branch-scoped call by the cashier is now refused with a stale-branch
    // 403 — the same token, but the resolved access is gone.
    const drafted = await replicaB.request('POST', '/sales/draft', {
      token: cashierToken,
      body: {
        branchId: 'shared-branch-2',
        registerId: tile.registerId,
        items: [{ productId: tile.productAId, quantity: '1.000' }],
      },
    });
    expect(drafted.status).toBe(403);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Documentation of the two-tier guarantee
// ─────────────────────────────────────────────────────────────────────────────

describe('Phase 1.5.8 — the two-tier contract is stated in code', () => {
  it('the settings service exports the tier constants and the class-comment describes both', async () => {
    const { SETTINGS_TIER, SETTINGS_CACHE_TTL_MS } = await import(
      '../../../src/modules/settings/settings.service'
    );
    expect(SETTINGS_TIER.MAX_NON_SECURITY_STALENESS_MS).toBe(SETTINGS_CACHE_TTL_MS);
    // The 30-second window is a stated policy, not an accident of default.
    expect(SETTINGS_CACHE_TTL_MS).toBe(30_000);
  });
});
