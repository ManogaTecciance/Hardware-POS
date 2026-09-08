/**
 * D55 console provisioning — slug rules and the trimmed role catalogue
 * (PO decisions, 2026-08-17), end to end through the real HTTP surface.
 *
 * D30 in both directions:
 *  - POSITIVE: each offered template creates a working workspace seeded with
 *    EXACTLY its staffed roles, and a well-formed slug is accepted.
 *  - NEGATIVE: malformed slugs are 400s; a duplicate slug — including one
 *    that differs only by CASE, and against a legacy mixed-case row — is a
 *    409, never a second workspace and never a raw database error.
 *
 * D108 adds the Salesperson: assignable through the console in a hardware
 * workspace, and in no other — the picker reads the workspace's own rows
 * (D55.1), so a restaurant simply has no such row to offer or accept.
 */
import { syncPermissionCatalogue } from '@hardware-pos/database';
import type { PrismaClient } from '@hardware-pos/database';

import { connectTestPrisma, disconnectTestPrisma } from '../prisma-test-client';
import { resetDatabase } from '../db-reset';
import { createHttpIntegrationApp, type HttpIntegrationApp } from '../http-test-app';

let prisma: PrismaClient;
let http: HttpIntegrationApp;
let adminToken: string;

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
  // Role seeding inside createWorkspace connects permissions by key.
  await syncPermissionCatalogue(prisma);
  // The console's own tenant + a platform administrator. The boundary guard
  // reads `isPlatformAdmin` from the JWT, so the token carries it.
  const platform = await prisma.tenant.create({
    data: { id: 'plat-tenant', name: 'Platform', slug: 'platform' },
  });
  const admin = await prisma.user.create({
    data: {
      id: 'plat-admin',
      tenantId: platform.id,
      role: 'OWNER',
      name: 'Console Admin',
      email: 'console@platform.test',
      isPlatformAdmin: true,
    },
  });
  adminToken = http.jwt.sign({
    sub: admin.id,
    tenantId: platform.id,
    role: 'OWNER',
    activeBranchId: null,
    isPlatformAdmin: true,
  });
});

const create = (body: Record<string, unknown>) =>
  http.request<{ id: string; slug: string }>('POST', '/platform-admin/workspaces', {
    token: adminToken,
    body: {
      name: 'Provisioning Test',
      templateKey: 'HARDWARE',
      ownerName: 'First Owner',
      ownerEmail: `owner-${Math.random().toString(36).slice(2, 10)}@prov.test`,
      ownerPassword: 'password123',
      ...body,
    },
  });

describe('slug rules', () => {
  it('refuses malformed slugs with a 400 naming the format', async () => {
    for (const bad of ['abc-', '-abc', 'a--b', 'has space', 'a']) {
      const res = await create({ slug: bad });
      expect({ slug: bad, status: res.status }).toEqual({ slug: bad, status: 400 });
    }
    // Positive control on the same shape: a well-formed slug creates.
    expect((await create({ slug: 'well-formed-1' })).status).toBe(201);
  });

  it('slugs are case-insensitively unique: an upper-case duplicate is a 409, not a new row', async () => {
    expect((await create({ slug: 'abc-abc' })).status).toBe(201);

    const dupe = await create({ slug: 'ABC-abc' });
    expect(dupe.status).toBe(409);
    expect(JSON.stringify(dupe.body)).toContain('abc-abc');
    // One workspace, stored lower-cased — the case variant created nothing.
    expect(await prisma.tenant.count({ where: { slug: { contains: 'abc-abc', mode: 'insensitive' } } })).toBe(1);
  });

  it('a LEGACY mixed-case row also blocks its lower-case twin', async () => {
    // Rows from before the console enforced lower-casing may carry case.
    await prisma.tenant.create({ data: { name: 'Legacy', slug: 'Legacy-Shop' } });
    const res = await create({ slug: 'legacy-shop' });
    expect(res.status).toBe(409);
  });

  it('mixed-case input is accepted and stored lower-cased', async () => {
    const res = await create({ slug: 'Seaside-HOTEL' });
    expect(res.status).toBe(201);
    expect(res.data.slug).toBe('seaside-hotel');
  });
});

describe('the trimmed role catalogue, per template', () => {
  const roleKeysOf = async (workspaceId: string) => {
    const res = await http.request<{ key: string }[]>(
      'GET',
      `/platform-admin/workspaces/${workspaceId}/roles`,
      { token: adminToken },
    );
    return res.data.map((r) => r.key).sort();
  };

  it('each template seeds exactly its staffed roles — nothing removed comes back', async () => {
    const cases: [string, string[]][] = [
      // D108 added SALESPERSON to hardware — the owner-equivalent counter
      // post — and to hardware ALONE: it must not appear in the two below.
      ['HARDWARE', ['CASHIER', 'OWNER', 'SALESPERSON']],
      // D68 added KITCHEN_STAFF to food service — the kitchen board replaced
      // the kitchen printer, so the board needs somebody rostered to it.
      // Hotel deliberately does NOT get it: a hotel workspace is the front
      // desk today, and nothing there works a pass.
      ['RESTAURANT', ['KITCHEN_STAFF', 'OWNER', 'RESTAURANT_CASHIER', 'WAITER']],
      ['HOTEL', ['OWNER', 'RECEPTIONIST', 'WAITER']],
    ];
    for (const [templateKey, expected] of cases) {
      const ws = await create({ slug: `roles-${templateKey.toLowerCase()}`, templateKey });
      expect(ws.status).toBe(201);
      expect({ templateKey, keys: await roleKeysOf(ws.data.id) }).toEqual({
        templateKey,
        keys: expected,
      });
    }
  });
});

describe('D108 — the Salesperson is assignable in a hardware workspace and nowhere else', () => {
  interface WorkspaceRole {
    id: string;
    key: string | null;
    name: string;
  }
  interface WorkspaceUser {
    id: string;
    role: string;
    roleKey: string | null;
    roleId: string | null;
  }

  const rolesOf = async (workspaceId: string) =>
    (
      await http.request<WorkspaceRole[]>('GET', `/platform-admin/workspaces/${workspaceId}/roles`, {
        token: adminToken,
      })
    ).data;

  const createUser = (workspaceId: string, body: Record<string, unknown>) =>
    http.request<WorkspaceUser>('POST', `/platform-admin/workspaces/${workspaceId}/users`, {
      token: adminToken,
      body: {
        name: 'Counter Sales',
        email: `sales-${Math.random().toString(36).slice(2, 10)}@prov.test`,
        password: 'password123',
        ...body,
      },
    });

  it('creates a user on the SALESPERSON row and can move them to the CASHIER row', async () => {
    const ws = await create({ slug: 'd100-hardware' });
    expect(ws.status).toBe(201);
    const roles = await rolesOf(ws.data.id);
    const salesperson = roles.find((r) => r.key === 'SALESPERSON');
    const cashier = roles.find((r) => r.key === 'CASHIER');
    expect(salesperson).toBeDefined();
    expect(cashier).toBeDefined();

    const created = await createUser(ws.data.id, { roleId: salesperson!.id });
    expect(created.status).toBe(201);
    // Both columns: the enum underneath and the row in force. Before D108 the
    // salesperson had no row, so the console could neither offer it nor show
    // it as anything but "Not set".
    expect(created.data).toMatchObject({
      role: 'SALESPERSON',
      roleKey: 'SALESPERSON',
      roleId: salesperson!.id,
    });

    const moved = await http.request<WorkspaceUser>(
      'PATCH',
      `/platform-admin/workspaces/${ws.data.id}/users/${created.data.id}`,
      { token: adminToken, body: { roleId: cashier!.id } },
    );
    expect(moved.status).toBe(200);
    // Both columns move together — leaving the enum behind is how a demoted
    // owner-level user would keep cross-branch visibility.
    expect(moved.data).toMatchObject({ role: 'CASHIER', roleKey: 'CASHIER', roleId: cashier!.id });
  });

  it('NEGATIVE: a restaurant workspace offers no Salesperson, and the hardware row cannot be borrowed', async () => {
    const hardware = await create({ slug: 'd100-hardware-2' });
    const restaurant = await create({ slug: 'd100-restaurant', templateKey: 'RESTAURANT' });
    expect(hardware.status).toBe(201);
    expect(restaurant.status).toBe(201);

    // Exact set, so the absence below is not satisfied by an empty picker.
    const restaurantRoles = await rolesOf(restaurant.data.id);
    expect(restaurantRoles.map((r) => r.key).sort()).toEqual([
      'KITCHEN_STAFF',
      'OWNER',
      'RESTAURANT_CASHIER',
      'WAITER',
    ]);
    expect(restaurantRoles.map((r) => r.key)).not.toContain('SALESPERSON');

    const foreign = (await rolesOf(hardware.data.id)).find((r) => r.key === 'SALESPERSON');
    expect(foreign).toBeDefined();
    const email = 'borrowed-salesperson@prov.test';
    const res = await createUser(restaurant.data.id, { roleId: foreign!.id, email });
    expect(res.status).toBe(400);
    // The 400 names what the workspace does offer; nothing was created.
    expect(JSON.stringify(res.body)).toContain('does not belong to this workspace');
    expect(await prisma.user.count({ where: { email } })).toBe(0);
  });
});
