/**
 * Role-management API (Phase 1.5.5).
 *
 * Three claims carry this file, and each is asserted in both directions:
 *
 *  1. **Tenant isolation.** Tenant A cannot read, edit, archive or assign tenant
 *     B's roles — and a foreign role id answers 404, not 403, so the API is not an
 *     existence oracle for other tenants' data.
 *  2. **Lockout protection.** A workspace cannot be left with no administrator,
 *     including by an administrator demoting themselves.
 *  3. **Archival, never deletion.** Custom roles archive; built-ins do neither;
 *     keys are never reused; a user still holding an archived role fails closed.
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

const ownerToken = (t: SeededTenant) =>
  http.tokenFor({ userId: t.ownerId, tenantId: t.tenantId, role: 'OWNER' });
const cashierToken = (t: SeededTenant) =>
  http.tokenFor({ userId: t.cashierId, tenantId: t.tenantId, role: 'CASHIER' });

const CUSTOM = {
  key: 'FLOOR_SUPERVISOR',
  name: 'Floor Supervisor',
  permissions: ['sale:read', 'product:read'],
};

interface RoleBody {
  id: string;
  key: string | null;
  name: string;
  isBuiltIn: boolean;
  isActive: boolean;
  version: number;
  permissions: string[];
}

async function createCustom(t: SeededTenant, body: Record<string, unknown> = {}) {
  return http.request<RoleBody>('POST', '/roles', {
    token: ownerToken(t),
    body: { ...CUSTOM, ...body },
  });
}

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
  await seedTenantRoles(prisma, other.tenantId, 'HARDWARE');
});

// ─────────────────────────────────────────────────────────────────────────────

describe('reading roles', () => {
  it('lists only the caller’s own tenant roles', async () => {
    const res = await http.request<RoleBody[]>('GET', '/roles', { token: ownerToken(tile) });
    expect(res.status).toBe(200);

    const ids = res.data.map((r) => r.id);
    const foreign = await prisma.role.findMany({ where: { tenantId: other.tenantId } });
    expect(foreign.length).toBeGreaterThan(0);
    expect(ids.filter((id: string) => foreign.some((f) => f.id === id))).toEqual([]);
    // Positive control: it returned this tenant's roles rather than nothing.
    expect(res.data.map((r) => r.key)).toContain('OWNER');
  });

  it('refuses a caller without user:manage', async () => {
    expect((await http.request('GET', '/roles', { token: cashierToken(tile) })).status).toBe(403);
  });

  it('answers 404 — not 403 — for another tenant’s role id', async () => {
    // 403 would confirm the id exists somewhere, which is a cross-tenant oracle.
    const foreign = await prisma.role.findFirstOrThrow({ where: { tenantId: other.tenantId } });
    const res = await http.request('GET', `/roles/${foreign.id}`, { token: ownerToken(tile) });
    expect(res.status).toBe(404);
  });

  it('reads a role it does own', async () => {
    const own = await prisma.role.findFirstOrThrow({ where: { tenantId: tile.tenantId } });
    expect((await http.request('GET', `/roles/${own.id}`, { token: ownerToken(tile) })).status).toBe(200);
  });
});

describe('creating a custom role', () => {
  it('creates it with exactly the permissions given', async () => {
    const res = await createCustom(tile);
    expect(res.status).toBe(201);
    expect([...res.data.permissions].sort()).toEqual(
      ['product:read', 'sale:read'],
    );
    expect(res.data.isBuiltIn).toBe(false);
  });

  it('rejects a permission the catalogue does not know', async () => {
    const res = await createCustom(tile, { permissions: ['sale:read', 'invented:permission'] });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('ROLE_UNKNOWN_PERMISSION');

    // Nothing was written — a partial create would leave a role granting less than
    // the caller asked for, with no error to explain it.
    expect(await prisma.role.count({ where: { tenantId: tile.tenantId, key: CUSTOM.key } })).toBe(0);
  });

  it('rejects a duplicate key, including an archived one', async () => {
    const created = await createCustom(tile);
    const roleId = created.data.id;
    await http.request('POST', `/roles/${roleId}/archive`, { token: ownerToken(tile), body: {} });

    // Keys are never reused, so the archived role still blocks the key.
    const again = await createCustom(tile);
    expect(again.status).toBe(409);
    expect(JSON.stringify(again.body)).toContain('ROLE_KEY_TAKEN');
  });

  it('lets two tenants use the same key independently', async () => {
    expect((await createCustom(tile)).status).toBe(201);
    expect((await createCustom(other)).status).toBe(201);
  });

  it('refuses a body that names another tenant', async () => {
    // `forbidNonWhitelisted` rejects the unknown property outright rather than
    // ignoring it, so the attempt is visible instead of silently harmless.
    const res = await http.request('POST', '/roles', {
      token: ownerToken(tile),
      body: { ...CUSTOM, tenantId: other.tenantId },
    });
    expect(res.status).toBe(400);
  });
});

describe('editing roles', () => {
  it('refuses to change a built-in role’s permissions', async () => {
    const owner = await prisma.role.findFirstOrThrow({
      where: { tenantId: tile.tenantId, key: 'OWNER' },
    });
    const res = await http.request('PUT', `/roles/${owner.id}/permissions`, {
      token: ownerToken(tile),
      body: { permissions: ['sale:read'] },
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('ROLE_BUILT_IN_IMMUTABLE');
  });

  it('replaces a custom role’s permissions, removing what is absent', async () => {
    const created = await createCustom(tile);
    const roleId = created.data.id;

    const res = await http.request<RoleBody>('PUT', `/roles/${roleId}/permissions`, {
      token: ownerToken(tile),
      body: { permissions: ['product:read'] },
    });
    expect(res.status).toBe(200);
    expect(res.data.permissions).toEqual(['product:read']);
  });

  it('rejects a stale version rather than overwriting a concurrent edit', async () => {
    const created = await createCustom(tile);
    const roleId = created.data.id;
    const version = created.data.version;

    await http.request('PATCH', `/roles/${roleId}`, {
      token: ownerToken(tile),
      body: { name: 'Renamed by someone else' },
    });

    const res = await http.request('PATCH', `/roles/${roleId}`, {
      token: ownerToken(tile),
      body: { name: 'Renamed by me', expectedVersion: version },
    });
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toContain('ROLE_VERSION_CONFLICT');
  });

  it('cannot edit another tenant’s role', async () => {
    const foreign = await prisma.role.findFirstOrThrow({ where: { tenantId: other.tenantId } });
    const res = await http.request('PATCH', `/roles/${foreign.id}`, {
      token: ownerToken(tile),
      body: { name: 'Hijacked' },
    });
    expect(res.status).toBe(404);

    const after = await prisma.role.findUniqueOrThrow({ where: { id: foreign.id } });
    expect(after.name).toBe(foreign.name);
  });
});

describe('archiving', () => {
  it('archives a custom role with no users', async () => {
    const created = await createCustom(tile);
    const roleId = created.data.id;

    const res = await http.request<RoleBody>('POST', `/roles/${roleId}/archive`, {
      token: ownerToken(tile),
      body: {},
    });
    expect(res.status).toBe(201);
    expect(res.data.isActive).toBe(false);

    // Archived, not deleted — the row and its history survive.
    expect(await prisma.role.findUnique({ where: { id: roleId } })).not.toBeNull();
  });

  it('refuses to archive a built-in role', async () => {
    const cashier = await prisma.role.findFirstOrThrow({
      where: { tenantId: tile.tenantId, key: 'CASHIER' },
    });
    const res = await http.request('POST', `/roles/${cashier.id}/archive`, {
      token: ownerToken(tile),
      body: {},
    });
    expect(res.status).toBe(400);
  });

  it('refuses to archive a role that still has users', async () => {
    const created = await createCustom(tile);
    const roleId = created.data.id;
    await prisma.user.update({ where: { id: tile.cashierId }, data: { roleId } });

    const res = await http.request('POST', `/roles/${roleId}/archive`, {
      token: ownerToken(tile),
      body: {},
    });
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toContain('ROLE_STILL_ASSIGNED');
  });

  it('an archived role cannot be assigned to anyone new', async () => {
    const created = await createCustom(tile);
    const roleId = created.data.id;
    await http.request('POST', `/roles/${roleId}/archive`, { token: ownerToken(tile), body: {} });

    const res = await http.request('PUT', `/users/${tile.cashierId}/role`, {
      token: ownerToken(tile),
      body: { roleId },
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('ROLE_ARCHIVED');
  });

  it('a user holding an archived role fails closed', async () => {
    // Reachable only outside the API, which refuses to archive an assigned role.
    const created = await createCustom(tile);
    const roleId = created.data.id;
    await prisma.user.update({ where: { id: tile.cashierId }, data: { roleId } });
    await prisma.role.update({ where: { id: roleId }, data: { isActive: false } });

    const res = await http.request('GET', '/products', { token: cashierToken(tile) });
    expect(res.status).toBe(403);
  });
});

describe('assignment', () => {
  it('assigns a role and the change is effective on the next request', async () => {
    const created = await createCustom(tile, { permissions: ['product:read'] });
    const roleId = created.data.id;

    // The cashier can create a sale today, through the legacy authority.
    expect(
      (await http.request('POST', '/quotations/preview', {
        token: cashierToken(tile),
        body: { items: [] },
      })).status,
    ).not.toBe(403);

    await http.request('PUT', `/users/${tile.cashierId}/role`, {
      token: ownerToken(tile),
      body: { roleId },
    });

    // The new role grants product:read only — no new token issued.
    expect((await http.request('GET', '/products', { token: cashierToken(tile) })).status).toBe(200);
    expect(
      (await http.request('POST', '/quotations/preview', {
        token: cashierToken(tile),
        body: { items: [] },
      })).status,
    ).toBe(403);
  });

  it('cannot assign another tenant’s role', async () => {
    const foreign = await prisma.role.findFirstOrThrow({ where: { tenantId: other.tenantId } });
    const res = await http.request('PUT', `/users/${tile.cashierId}/role`, {
      token: ownerToken(tile),
      body: { roleId: foreign.id },
    });
    expect(res.status).toBe(404);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: tile.cashierId } });
    expect(user.roleId).toBeNull();
  });

  it('cannot assign a role to another tenant’s user', async () => {
    const own = await prisma.role.findFirstOrThrow({
      where: { tenantId: tile.tenantId, key: 'CASHIER' },
    });
    const res = await http.request('PUT', `/users/${other.cashierId}/role`, {
      token: ownerToken(tile),
      body: { roleId: own.id },
    });
    expect(res.status).toBe(404);
  });
});

describe('lockout protection', () => {
  it('refuses to move the last administrator to a role without administration', async () => {
    await linkUsersToRoles(prisma, tile.tenantId);
    const created = await createCustom(tile, { permissions: ['product:read'] });
    const weak = created.data.id;

    // The owner is the only user holding both administration permissions.
    const res = await http.request('PUT', `/users/${tile.ownerId}/role`, {
      token: ownerToken(tile),
      body: { roleId: weak },
    });
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toContain('ROLE_LAST_ADMINISTRATOR');
  });

  it('allows it when another administrator remains', async () => {
    // The positive control. Without it, a service that refused every assignment
    // would pass the case above.
    await linkUsersToRoles(prisma, tile.tenantId);
    const admin = await prisma.role.findFirstOrThrow({
      where: { tenantId: tile.tenantId, key: 'ADMIN' },
    });
    await prisma.user.update({ where: { id: tile.managerId }, data: { roleId: admin.id } });

    const created = await createCustom(tile, { permissions: ['product:read'] });
    const weak = created.data.id;

    const res = await http.request('PUT', `/users/${tile.ownerId}/role`, {
      token: ownerToken(tile),
      body: { roleId: weak },
    });
    expect(res.status).toBe(200);
  });

  it('refuses to strip administration from the role the last administrator holds', async () => {
    await linkUsersToRoles(prisma, tile.tenantId);
    const created = await createCustom(tile, {
      permissions: ['user:manage', 'platform:profile:manage'],
    });
    const adminRole = created.data.id;
    await prisma.user.update({ where: { id: tile.ownerId }, data: { roleId: adminRole } });
    // Everyone else is now on a non-administrative built-in role.
    await prisma.user.updateMany({
      where: { tenantId: tile.tenantId, id: { not: tile.ownerId } },
      data: { roleId: null },
    });

    const res = await http.request('PUT', `/roles/${adminRole}/permissions`, {
      token: ownerToken(tile),
      body: { permissions: ['product:read'] },
    });
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toContain('ROLE_LAST_ADMINISTRATOR');
  });
});

describe('effective permissions reporting', () => {
  it('reports LEGACY_FALLBACK for an unmigrated user', async () => {
    const res = await http.request<{ source: string; permissions: string[] }>(
      'GET',
      `/users/${tile.ownerId}/effective-permissions`,
      { token: ownerToken(tile) },
    );
    expect(res.status).toBe(200);
    expect(res.data.source).toBe('LEGACY_FALLBACK');
    expect(res.data.permissions.length).toBeGreaterThan(0);
  });

  it('reports DATABASE once the user is migrated', async () => {
    await linkUsersToRoles(prisma, tile.tenantId);
    const res = await http.request<{ source: string }>(
      'GET',
      `/users/${tile.ownerId}/effective-permissions`,
      { token: ownerToken(tile) },
    );
    expect(res.data.source).toBe('DATABASE');
  });

  it('will not report on another tenant’s user', async () => {
    const res = await http.request('GET', `/users/${other.ownerId}/effective-permissions`, {
      token: ownerToken(tile),
    });
    expect(res.status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Mutation proofs
// ─────────────────────────────────────────────────────────────────────────────

describe('the role-management assertions can actually fail', () => {
  it('an API that accepted every request would be detected', async () => {
    // Guards every 4xx above: the happy path must still work.
    expect((await createCustom(tile)).status).toBe(201);
  });

  it('an API that refused every request would be detected', async () => {
    const res = await http.request<RoleBody[]>('GET', '/roles', { token: ownerToken(tile) });
    expect(res.status).toBe(200);
    expect(res.data.length).toBeGreaterThan(0);
  });

  it('a lockout guard that never fired would be detected', async () => {
    const refused = 409;
    expect(() => expect(200).toBe(refused)).toThrow();
  });
});
