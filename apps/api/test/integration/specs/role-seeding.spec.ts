/**
 * Seeded role and permission rows match the code authority (Phase 1.5, D36/D37).
 *
 * `role-templates.parity.spec.ts` compares the templates against
 * `ROLE_PERMISSIONS` in memory. This one runs the seeding function against a real
 * PostgreSQL and compares what actually landed in the tables — which is the only
 * thing authorization will eventually read. The two are different claims: a
 * template can be correct while the code that writes it drops half the rows.
 *
 * This slice lands the authority **inert**. Nothing here asserts that the rows
 * grant anything, because nothing resolves permissions from them yet; the switch
 * is a later slice, fenced by these tests.
 */
import {
  ALL_PERMISSIONS,
  BUILT_IN_ROLE_TEMPLATES,
  Permission,
  RESTAURANT_ROLE_TEMPLATES,
  ROLE_PERMISSIONS,
  roleTemplatesForBusinessType,
} from '@hardware-pos/shared';
import { seedTenantRoles, syncPermissionCatalogue } from '@hardware-pos/database';

import type { PrismaClient } from '@hardware-pos/database';

import { connectTestPrisma, disconnectTestPrisma } from '../prisma-test-client';
import { resetDatabase } from '../db-reset';

let prisma: PrismaClient;

/** Minimal tenant — this spec is about roles, not about the rest of a tenant. */
async function makeTenant(id: string, slug: string) {
  await prisma.tenant.create({ data: { id, name: id, slug } });
  return id;
}

async function rolesOf(tenantId: string) {
  const rows = await prisma.role.findMany({
    where: { tenantId },
    include: { permissions: { select: { key: true } } },
    orderBy: { key: 'asc' },
  });
  return rows.map((r: (typeof rows)[number]) => ({
    key: r.key,
    name: r.name,
    isSystem: r.isSystem,
    permissions: r.permissions.map((p: { key: string }) => p.key).sort(),
  }));
}

beforeAll(async () => {
  prisma = await connectTestPrisma();
});

afterAll(async () => {
  await disconnectTestPrisma();
});

beforeEach(async () => {
  await resetDatabase(prisma);
});

// ─────────────────────────────────────────────────────────────────────────────

describe('the permission catalogue', () => {
  it('writes exactly the code catalogue, no more and no less', async () => {
    await syncPermissionCatalogue(prisma);

    const rows = await prisma.permission.findMany({ select: { key: true } });
    expect(rows.map((r: { key: string }) => r.key).sort()).toEqual([...ALL_PERMISSIONS].sort());
    // Positive control: the catalogue is not empty, so the equality above is a
    // real comparison rather than [] === [].
    expect(rows.length).toBeGreaterThan(20);
  });

  it('is idempotent', async () => {
    await syncPermissionCatalogue(prisma);
    const first = await prisma.permission.count();
    await syncPermissionCatalogue(prisma);
    expect(await prisma.permission.count()).toBe(first);
  });
});

describe('seeding a retail tenant', () => {
  it('creates exactly the five built-in roles with the authority’s permissions', async () => {
    const tenantId = await makeTenant('tnt_retail', 'retail');
    await syncPermissionCatalogue(prisma);
    await seedTenantRoles(prisma, tenantId, 'HARDWARE');

    const roles = await rolesOf(tenantId);
    expect(roles.map((r) => r.key as string)).toEqual(
      BUILT_IN_ROLE_TEMPLATES.map((t) => t.key).sort(),
    );

    for (const role of roles) {
      expect({ key: role.key, permissions: role.permissions }).toEqual({
        key: role.key,
        permissions: [...ROLE_PERMISSIONS[role.key as keyof typeof ROLE_PERMISSIONS]].sort(),
      });
    }
  });

  it('creates no restaurant role', async () => {
    const tenantId = await makeTenant('tnt_retail2', 'retail2');
    await syncPermissionCatalogue(prisma);
    await seedTenantRoles(prisma, tenantId, 'HARDWARE');

    const keys = (await rolesOf(tenantId)).map((r) => r.key);
    for (const template of RESTAURANT_ROLE_TEMPLATES) {
      expect({ tenant: 'retail', absent: template.key, present: keys.includes(template.key) }).toEqual(
        { tenant: 'retail', absent: template.key, present: false },
      );
    }
    // Paired positive: it did create the built-ins, so the negatives above are not
    // satisfied by an empty table.
    expect(keys).toContain('OWNER');
  });

  it('marks built-in roles as system roles, so a tenant cannot delete them', async () => {
    const tenantId = await makeTenant('tnt_retail3', 'retail3');
    await syncPermissionCatalogue(prisma);
    await seedTenantRoles(prisma, tenantId, 'HARDWARE');

    expect((await rolesOf(tenantId)).every((r) => r.isSystem)).toBe(true);
  });
});

describe('seeding a restaurant tenant', () => {
  it('creates the built-in roles plus the restaurant roles', async () => {
    const tenantId = await makeTenant('tnt_food', 'food');
    await syncPermissionCatalogue(prisma);
    await seedTenantRoles(prisma, tenantId, 'RESTAURANT');

    const roles = await rolesOf(tenantId);
    expect(roles.map((r) => r.key).sort()).toEqual(
      roleTemplatesForBusinessType('RESTAURANT').map((t) => t.key).sort(),
    );
    expect(roles.find((r) => r.key === 'WAITER')!.isSystem).toBe(false);
  });

  it('gives the waiter its template permissions and nothing more', async () => {
    const tenantId = await makeTenant('tnt_food2', 'food2');
    await syncPermissionCatalogue(prisma);
    await seedTenantRoles(prisma, tenantId, 'RESTAURANT');

    const waiter = (await rolesOf(tenantId)).find((r) => r.key === 'WAITER')!;
    const template = RESTAURANT_ROLE_TEMPLATES.find((t) => t.key === 'WAITER')!;
    expect(waiter.permissions).toEqual([...template.permissions].sort());

    // The two a waiter must NOT hold, stated explicitly because they are the ones
    // that cost money when wrong.
    expect(waiter.permissions).not.toContain(Permission.ORDER_VOID_SENT);
    expect(waiter.permissions).not.toContain(Permission.TABLE_TRANSFER);
  });
});

describe('roles never cross a tenant boundary (D36)', () => {
  it('two tenants get independent rows with the same keys', async () => {
    const a = await makeTenant('tnt_a', 'a');
    const b = await makeTenant('tnt_b', 'b');
    await syncPermissionCatalogue(prisma);
    await seedTenantRoles(prisma, a, 'HARDWARE');
    await seedTenantRoles(prisma, b, 'RESTAURANT');

    const aRows = await prisma.role.findMany({ where: { tenantId: a }, select: { id: true, key: true } });
    const bRows = await prisma.role.findMany({ where: { tenantId: b }, select: { id: true, key: true } });

    // Same key, different row. A shared row is the cross-tenant write surface D36
    // exists to avoid.
    const aOwner = aRows.find((r) => r.key === 'OWNER')!;
    const bOwner = bRows.find((r) => r.key === 'OWNER')!;
    expect(aOwner.id).not.toBe(bOwner.id);

    const aIds = new Set(aRows.map((r) => r.id));
    expect(bRows.filter((r) => aIds.has(r.id))).toEqual([]);
    expect(aRows.length).toBeGreaterThan(0);
    expect(bRows.length).toBeGreaterThan(0);
  });

  it('a role key is unique within a tenant but not across tenants', async () => {
    const a = await makeTenant('tnt_c', 'c');
    await syncPermissionCatalogue(prisma);
    await seedTenantRoles(prisma, a, 'HARDWARE');

    // The database, not the application, is what enforces this.
    await expect(
      prisma.role.create({ data: { tenantId: a, key: 'OWNER', name: 'Another Owner' } }),
    ).rejects.toThrow();
  });

  it('editing one tenant’s role leaves the other untouched', async () => {
    const a = await makeTenant('tnt_d', 'd');
    const b = await makeTenant('tnt_e', 'e');
    await syncPermissionCatalogue(prisma);
    await seedTenantRoles(prisma, a, 'HARDWARE');
    await seedTenantRoles(prisma, b, 'HARDWARE');

    await prisma.role.update({
      where: { tenantId_key: { tenantId: a, key: 'MANAGER' } },
      data: { name: 'Supervisor' },
    });

    const bManager = await prisma.role.findUnique({
      where: { tenantId_key: { tenantId: b, key: 'MANAGER' } },
    });
    expect(bManager!.name).toBe('Manager');
  });
});

describe('re-seeding an existing tenant', () => {
  it('does not undo a display-name change', async () => {
    // A tenant renaming a role is a legitimate customisation. A seed that reverted
    // it would be discovered by an operator, not by a test.
    const tenantId = await makeTenant('tnt_rename', 'rename');
    await syncPermissionCatalogue(prisma);
    await seedTenantRoles(prisma, tenantId, 'HARDWARE');

    await prisma.role.update({
      where: { tenantId_key: { tenantId, key: 'MANAGER' } },
      data: { name: 'Shift Supervisor' },
    });
    await seedTenantRoles(prisma, tenantId, 'HARDWARE');

    const manager = await prisma.role.findUnique({
      where: { tenantId_key: { tenantId, key: 'MANAGER' } },
    });
    expect(manager!.name).toBe('Shift Supervisor');
  });

  it('does re-apply permission assignments, including revocations', async () => {
    // The other half: permissions are the platform's definition of the role, so a
    // hand-edited assignment is repaired rather than preserved. Without `set`
    // semantics a permission removed from a template would live on forever.
    const tenantId = await makeTenant('tnt_repair', 'repair');
    await syncPermissionCatalogue(prisma);
    await seedTenantRoles(prisma, tenantId, 'HARDWARE');

    await prisma.role.update({
      where: { tenantId_key: { tenantId, key: 'CASHIER' } },
      data: { permissions: { connect: [{ key: Permission.SETTINGS_MANAGE }] } },
    });
    await seedTenantRoles(prisma, tenantId, 'HARDWARE');

    const cashier = (await rolesOf(tenantId)).find((r) => r.key === 'CASHIER')!;
    expect(cashier.permissions).toEqual([...ROLE_PERMISSIONS.CASHIER].sort());
    expect(cashier.permissions).not.toContain(Permission.SETTINGS_MANAGE);
  });

  it('creates no duplicate rows on a second run', async () => {
    const tenantId = await makeTenant('tnt_twice', 'twice');
    await syncPermissionCatalogue(prisma);
    await seedTenantRoles(prisma, tenantId, 'RESTAURANT');
    const first = await prisma.role.count({ where: { tenantId } });

    await seedTenantRoles(prisma, tenantId, 'RESTAURANT');
    expect(await prisma.role.count({ where: { tenantId } })).toBe(first);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Mutation proofs
// ─────────────────────────────────────────────────────────────────────────────

describe('the seeding assertions can actually fail', () => {
  it('a role seeded with the wrong permissions would be detected', async () => {
    const tenantId = await makeTenant('tnt_mutate', 'mutate');
    await syncPermissionCatalogue(prisma);
    await seedTenantRoles(prisma, tenantId, 'HARDWARE');

    const cashier = (await rolesOf(tenantId)).find((r) => r.key === 'CASHIER')!;
    expect(cashier.permissions).toEqual([...ROLE_PERMISSIONS.CASHIER].sort());

    const over = [...cashier.permissions, Permission.SETTINGS_MANAGE].sort();
    expect(() => expect(over).toEqual([...ROLE_PERMISSIONS.CASHIER].sort())).toThrow();
  });

  it('a seeding function that wrote nothing would be detected', async () => {
    // Guards every "does not contain" above: an empty table satisfies them all.
    const tenantId = await makeTenant('tnt_empty', 'empty');
    expect(await prisma.role.count({ where: { tenantId } })).toBe(0);
    expect(() => expect([]).toContain('OWNER')).toThrow();
  });
});
