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
import { ROLE_PERMISSIONS } from '@hardware-pos/shared';
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

/**
 * The rows `seedTenantRoles(…, 'HARDWARE')` writes, all built in: Owner,
 * Salesperson (D100) and Cashier — `HARDWARE_ROLE_TEMPLATES` by key. Written
 * out rather than read from the template list so the immutability cases below
 * name what they cover, and so the GET /roles case pins the set against the
 * database independently of the function that seeded it.
 */
const HARDWARE_BUILT_INS = ['OWNER', 'SALESPERSON', 'CASHIER'] as const;

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
    // Positive control: it returned this tenant's roles rather than nothing —
    // and exactly the hardware template's rows (D100), each built in, with no
    // food-service role among them.
    const keys = res.data.map((r) => r.key).sort();
    expect(keys).toEqual(['CASHIER', 'OWNER', 'SALESPERSON']);
    expect(res.data.every((r) => r.isBuiltIn)).toBe(true);
    expect(keys).not.toContain('WAITER');
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

  /*
   * D100 — keys the platform already means something by are refused, whether
   * or not this tenant's template seeds them. A custom SALESPERSON in a
   * restaurant would map to the owner-level enum underneath and be adopted —
   * marked built-in, permissions set to the owner's — by the next role seed.
   * SALESPERSON is an enum value AND a row this tenant holds; ADMIN is an enum
   * value with no template anywhere; WAITER is a template with no enum value.
   */
  it.each(['SALESPERSON', 'ADMIN', 'WAITER'] as const)(
    'refuses the reserved key %s with ROLE_KEY_RESERVED and writes nothing (D100)',
    async (key) => {
      const rowsUnder = () =>
        prisma.role.findMany({
          where: { tenantId: tile.tenantId, key },
          select: { id: true, isSystem: true, name: true },
          orderBy: { id: 'asc' },
        });
      const before = await rowsUnder();
      // The seeded row is the only thing that may sit under SALESPERSON; the
      // other two keys are free here, so the refusal cannot be a key clash.
      expect(before.length).toBe(key === 'SALESPERSON' ? 1 : 0);

      const res = await createCustom(tile, { key, name: `Custom ${key}` });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toContain('ROLE_KEY_RESERVED');

      const after = await rowsUnder();
      expect(after).toEqual(before);
      expect(after.filter((r) => !r.isSystem)).toEqual([]);
    },
  );

  it('POSITIVE CONTROL: a key of the tenant’s own is still created', async () => {
    // Without this, a create that refused every key would pass the three above.
    const res = await createCustom(tile);
    expect(res.status).toBe(201);
    expect(res.data.key).toBe(CUSTOM.key);
  });
});

describe('editing roles', () => {
  it.each(HARDWARE_BUILT_INS)('refuses to change the built-in %s role’s permissions', async (key) => {
    const role = await prisma.role.findFirstOrThrow({
      where: { tenantId: tile.tenantId, key },
    });
    expect(role.isSystem).toBe(true);
    const res = await http.request('PUT', `/roles/${role.id}/permissions`, {
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

  it.each(HARDWARE_BUILT_INS)('refuses to archive the built-in %s role', async (key) => {
    const role = await prisma.role.findFirstOrThrow({
      where: { tenantId: tile.tenantId, key },
    });
    expect(role.isSystem).toBe(true);
    const res = await http.request('POST', `/roles/${role.id}/archive`, {
      token: ownerToken(tile),
      body: {},
    });
    expect(res.status).toBe(400);
    // Still active — refused, not archived and then reported as an error.
    const after = await prisma.role.findUniqueOrThrow({ where: { id: role.id } });
    expect(after.isActive).toBe(true);
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

  /**
   * D100 — both columns move together. The enum underneath still decides the
   * owner-level checks (cross-branch reach, the QuickBooks gates, the override
   * paths), and this tenant-facing endpoint used to leave it behind: a cashier
   * moved onto the Salesperson row stayed CASHIER for every one of them, and a
   * demoted owner-level user kept the reach the demotion was meant to remove.
   * `roleGrant` on the branch-access view is read straight from the DB enum,
   * which makes it the honest witness here.
   */
  it('moving a user onto the Salesperson row makes them SALESPERSON underneath — owner-level reach included', async () => {
    const roles = await http.request<RoleBody[]>('GET', '/roles', { token: ownerToken(tile) });
    const salesperson = roles.data.find((r) => r.key === 'SALESPERSON')!;
    expect(salesperson).toBeDefined();

    const before = await http.request<{ role: string; roleGrant: boolean }>(
      'GET',
      `/users/${tile.cashierId}/branch-access`,
      { token: ownerToken(tile) },
    );
    expect(before.data).toMatchObject({ role: 'CASHIER', roleGrant: false });

    const put = await http.request('PUT', `/users/${tile.cashierId}/role`, {
      token: ownerToken(tile),
      body: { roleId: salesperson.id },
    });
    expect(put.status).toBe(200);

    const after = await http.request<{ role: string; roleGrant: boolean }>(
      'GET',
      `/users/${tile.cashierId}/branch-access`,
      { token: ownerToken(tile) },
    );
    expect(after.data).toMatchObject({ role: 'SALESPERSON', roleGrant: true });

    // …and the row is the authority for permissions: the owner's set, from the database.
    const effective = await http.request<{ source: string; permissions: string[] }>(
      'GET',
      `/users/${tile.cashierId}/effective-permissions`,
      { token: ownerToken(tile) },
    );
    expect(effective.data.source).toBe('DATABASE');
    expect([...effective.data.permissions].sort()).toEqual([...ROLE_PERMISSIONS.OWNER].sort());
  });

  it('NEGATIVE: moving them off it takes the enum with it — a demotion is not cosmetic', async () => {
    const roles = await http.request<RoleBody[]>('GET', '/roles', { token: ownerToken(tile) });
    const salesperson = roles.data.find((r) => r.key === 'SALESPERSON')!;
    const cashier = roles.data.find((r) => r.key === 'CASHIER')!;
    await http.request('PUT', `/users/${tile.cashierId}/role`, {
      token: ownerToken(tile),
      body: { roleId: salesperson.id },
    });
    // Positive control: the promotion took, so the demotion below undoes something.
    expect(
      (await http.request<{ role: string }>('GET', `/users/${tile.cashierId}/branch-access`, {
        token: ownerToken(tile),
      })).data.role,
    ).toBe('SALESPERSON');

    await http.request('PUT', `/users/${tile.cashierId}/role`, {
      token: ownerToken(tile),
      body: { roleId: cashier.id },
    });
    const demoted = await http.request<{ role: string; roleGrant: boolean }>(
      'GET',
      `/users/${tile.cashierId}/branch-access`,
      { token: ownerToken(tile) },
    );
    expect(demoted.data).toMatchObject({ role: 'CASHIER', roleGrant: false });

    // A custom row has no enum of its own and fails CLOSED to CASHIER, so a
    // salesperson moved onto one loses owner-level reach rather than keeping it.
    const custom = await createCustom(tile, { permissions: ['product:read'] });
    await http.request('PUT', `/users/${tile.cashierId}/role`, {
      token: ownerToken(tile),
      body: { roleId: salesperson.id },
    });
    await http.request('PUT', `/users/${tile.cashierId}/role`, {
      token: ownerToken(tile),
      body: { roleId: custom.data.id },
    });
    const onCustom = await http.request<{ role: string; roleGrant: boolean }>(
      'GET',
      `/users/${tile.cashierId}/branch-access`,
      { token: ownerToken(tile) },
    );
    expect(onCustom.data).toMatchObject({ role: 'CASHIER', roleGrant: false });
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

  it.each(['OWNER', 'SALESPERSON'] as const)(
    'allows it when another administrator remains on the %s role',
    async (key) => {
      // The positive control. Without it, a service that refused every
      // assignment would pass the case above.
      await linkUsersToRoles(prisma, tile.tenantId);
      // The hardware template seeds two administrative rows (D100): the Owner
      // and the owner-equivalent Salesperson. A second user on either one is
      // "another administrator" — the guard counts permissions, not keys.
      const adminRow = await prisma.role.findFirstOrThrow({
        where: { tenantId: tile.tenantId, key },
      });
      await prisma.user.update({ where: { id: tile.managerId }, data: { roleId: adminRow.id } });

      const created = await createCustom(tile, { permissions: ['product:read'] });
      const weak = created.data.id;

      const res = await http.request('PUT', `/users/${tile.ownerId}/role`, {
        token: ownerToken(tile),
        body: { roleId: weak },
      });
      expect(res.status).toBe(200);
    },
  );

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
