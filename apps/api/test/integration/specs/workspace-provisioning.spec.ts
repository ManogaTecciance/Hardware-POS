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
      ['HARDWARE', ['CASHIER', 'OWNER']],
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
