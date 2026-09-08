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
  BUSINESS_TYPE_VALUES,
  Permission,
  RESTAURANT_ROLE_TEMPLATES,
  ROLE_PERMISSIONS,
} from '@hardware-pos/shared';
import { linkUsersToRoles, seedTenantRoles, syncPermissionCatalogue } from '@hardware-pos/database';

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
  it('creates exactly Owner, Salesperson and Cashier with the authority’s permissions', async () => {
    // PO decision 2026-08-17: a hardware workspace staffs an Owner and
    // Cashiers — the other built-ins are no longer part of its template.
    // D108 (2026-09-08) added the Salesperson: owner-equivalent, hardware only.
    const tenantId = await makeTenant('tnt_retail', 'retail');
    await syncPermissionCatalogue(prisma);
    await seedTenantRoles(prisma, tenantId, 'HARDWARE');

    const roles = await rolesOf(tenantId);
    expect(roles.map((r) => r.key as string)).toEqual(['CASHIER', 'OWNER', 'SALESPERSON']);

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

    const roles = await rolesOf(tenantId);
    expect(roles.every((r) => r.isSystem)).toBe(true);
    // Positive control, and the D108 row is among the undeletable ones.
    expect(roles.map((r) => r.key)).toContain('SALESPERSON');
  });

  it('seeds the Salesperson row with exactly the Owner row’s permissions (D108)', async () => {
    const tenantId = await makeTenant('tnt_retail4', 'retail4');
    await syncPermissionCatalogue(prisma);
    await seedTenantRoles(prisma, tenantId, 'HARDWARE');

    const roles = await rolesOf(tenantId);
    const owner = roles.find((r) => r.key === 'OWNER')!;
    const salesperson = roles.find((r) => r.key === 'SALESPERSON')!;
    expect(salesperson).toBeDefined();
    expect(salesperson.name).toBe('Salesperson');
    expect(salesperson.permissions).toEqual(owner.permissions);
    // NEGATIVE — equal to the owner, not to the till; and both are populated,
    // so the equality above compared real sets.
    expect(salesperson.permissions).not.toEqual(roles.find((r) => r.key === 'CASHIER')!.permissions);
    expect(salesperson.permissions.length).toBeGreaterThan(20);
  });

  it('gives the Salesperson row to no other template (D108)', async () => {
    // Every business type except HARDWARE, taken from the authority rather
    // than listed here so a type added to the enum is seeded and checked
    // without a second edit. The row must be absent from each, and the OWNER
    // row present in each so an empty table could not satisfy the absence.
    const nonHardware = BUSINESS_TYPE_VALUES.filter((type) => type !== 'HARDWARE');
    // POSITIVE CONTROL on the loop itself: the filter removed exactly HARDWARE
    // and left something to iterate — an empty list would pass by doing nothing.
    expect(BUSINESS_TYPE_VALUES).toContain('HARDWARE');
    expect(nonHardware.length).toBe(BUSINESS_TYPE_VALUES.length - 1);
    expect(nonHardware.length).toBeGreaterThan(0);

    await syncPermissionCatalogue(prisma);
    for (const type of nonHardware) {
      const id = `tnt_np_${type.toLowerCase()}`;
      await makeTenant(id, id.replace('tnt_', ''));
      await seedTenantRoles(prisma, id, type);
      const keys = (await rolesOf(id)).map((r) => r.key);
      expect({ type, salesperson: keys.includes('SALESPERSON'), owner: keys.includes('OWNER') }).toEqual({
        type,
        salesperson: false,
        owner: true,
      });
    }
  });
});

describe('seeding a restaurant tenant', () => {
  it('creates the built-in roles plus the restaurant roles', async () => {
    const tenantId = await makeTenant('tnt_food', 'food');
    await syncPermissionCatalogue(prisma);
    await seedTenantRoles(prisma, tenantId, 'RESTAURANT');

    const roles = await rolesOf(tenantId);
    // The literal set, not `roleTemplatesForBusinessType('RESTAURANT')`:
    // compared to the function that wrote them, the rows would match ANY
    // template list — one that leaked the Salesperson in included (D108).
    expect(roles.map((r) => r.key).sort()).toEqual([
      'KITCHEN_STAFF',
      'OWNER',
      'RESTAURANT_CASHIER',
      'WAITER',
    ]);
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
      where: { tenantId_key: { tenantId: a, key: 'CASHIER' } },
      data: { name: 'Till Operator' },
    });

    const bCashier = await prisma.role.findUnique({
      where: { tenantId_key: { tenantId: b, key: 'CASHIER' } },
    });
    expect(bCashier!.name).toBe('Cashier');
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
      where: { tenantId_key: { tenantId, key: 'CASHIER' } },
      data: { name: 'Shift Supervisor' },
    });
    await seedTenantRoles(prisma, tenantId, 'HARDWARE');

    const cashier = await prisma.role.findUnique({
      where: { tenantId_key: { tenantId, key: 'CASHIER' } },
    });
    expect(cashier!.name).toBe('Shift Supervisor');
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

/**
 * D108 — the seed runs against EXISTING tenants (the production backfill is
 * exactly that), so a row it finds under a template key is not necessarily one
 * it wrote. Adopting a tenant-created row would `set` the template's
 * permissions onto it — for SALESPERSON, the owner's — promoting everyone
 * holding a narrow custom role on an idempotent re-run. So it refuses, and it
 * names a display-name clash before writing rather than failing on the unique
 * constraint half-way through the loop.
 */
describe('seeding refuses a tenant’s own row under a template key or name (D108)', () => {
  it('throws on a NON-system row under a BUILT-IN template key, and leaves the row alone', async () => {
    const tenantId = await makeTenant('tnt_custom_key', 'custom-key');
    await syncPermissionCatalogue(prisma);
    // A custom role from before `RolesService.create` reserved the key.
    // Deliberately narrow: it is what adoption would have widened. The rule is
    // "a built-in's row must be a system row" — the operational templates
    // (Waiter, Kitchen staff, …) are seeded as non-system rows by design and
    // keep being adopted, which 'creates no duplicate rows on a second run'
    // above proves for a restaurant.
    await prisma.role.create({
      data: {
        tenantId,
        key: 'SALESPERSON',
        name: 'Floor sales',
        isSystem: false,
        permissions: { connect: [{ key: Permission.SALE_READ }] },
      },
    });

    await expect(seedTenantRoles(prisma, tenantId, 'HARDWARE')).rejects.toThrow(/tenant-created role/);

    const row = (await rolesOf(tenantId)).find((r) => r.key === 'SALESPERSON');
    expect(row).toEqual({
      key: 'SALESPERSON',
      name: 'Floor sales',
      isSystem: false,
      permissions: [Permission.SALE_READ],
    });
  });

  it('throws on a display-name collision, naming the clashing key, before writing the template', async () => {
    const tenantId = await makeTenant('tnt_name_clash', 'name-clash');
    await syncPermissionCatalogue(prisma);
    await prisma.role.create({
      data: { tenantId, key: 'FLOOR', name: 'Salesperson', isSystem: false },
    });

    await expect(seedTenantRoles(prisma, tenantId, 'HARDWARE')).rejects.toThrow(
      /already exists \(key FLOOR\)/,
    );

    const keys = (await rolesOf(tenantId)).map((r) => r.key);
    expect(keys).not.toContain('SALESPERSON');
    // Named, not swallowed as a constraint error — and the offending row is
    // still there to rename.
    expect(keys).toContain('FLOOR');
  });

  it('POSITIVE CONTROL: a SYSTEM row under the key is refreshed, not refused', async () => {
    // The pair for the two refusals: without it, a seed that threw on every
    // existing row would pass both.
    const tenantId = await makeTenant('tnt_system_key', 'system-key');
    await syncPermissionCatalogue(prisma);
    await prisma.role.create({
      data: {
        tenantId,
        key: 'SALESPERSON',
        name: 'Salesperson',
        isSystem: true,
        permissions: { connect: [{ key: Permission.SALE_READ }] },
      },
    });

    await expect(seedTenantRoles(prisma, tenantId, 'HARDWARE')).resolves.toBeDefined();

    const row = (await rolesOf(tenantId)).find((r) => r.key === 'SALESPERSON')!;
    expect(row.isSystem).toBe(true);
    expect(row.permissions).toEqual([...ROLE_PERMISSIONS.SALESPERSON].sort());
    expect(row.permissions.length).toBeGreaterThan(1);
  });
});

/**
 * D108 — `linkUsersToRoles` is what moves a salesperson off the legacy
 * fallback. It links by enum key to SEEDED (`isSystem`), ACTIVE rows in the
 * user's own tenant and nothing else: no row, no link; an archived row, no
 * link; a tenant-created row that happens to carry the key, no link. Each
 * refusal below is paired with the same row made eligible, so it is that one
 * property — not the key or the tenant — that decides.
 */
describe('linking users to rows (D108)', () => {
  async function userOf(tenantId: string, role: 'SALESPERSON' | 'OWNER' | 'MANAGER'): Promise<string> {
    const id = `${tenantId}-${role.toLowerCase()}`;
    await prisma.user.create({
      data: {
        id,
        tenantId,
        role,
        roleId: null,
        name: `${role} of ${tenantId}`,
        email: `${role.toLowerCase()}@${tenantId}.test`,
      },
    });
    return id;
  }

  const roleIdOf = async (userId: string) =>
    (await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { roleId: true } })).roleId;

  it('links a SALESPERSON user to the SALESPERSON row in a hardware tenant', async () => {
    const tenantId = await makeTenant('tnt_link_hw', 'link-hw');
    await syncPermissionCatalogue(prisma);
    await seedTenantRoles(prisma, tenantId, 'HARDWARE');
    const userId = await userOf(tenantId, 'SALESPERSON');

    expect(await linkUsersToRoles(prisma, tenantId)).toBe(1);

    const row = await prisma.role.findUniqueOrThrow({
      where: { tenantId_key: { tenantId, key: 'SALESPERSON' } },
      select: { id: true },
    });
    expect(await roleIdOf(userId)).toBe(row.id);
  });

  it('NEGATIVE: leaves the same user unlinked in a GENERAL tenant, which has no such row', async () => {
    const tenantId = await makeTenant('tnt_link_gen', 'link-gen');
    await syncPermissionCatalogue(prisma);
    await seedTenantRoles(prisma, tenantId, 'GENERAL');
    const salesperson = await userOf(tenantId, 'SALESPERSON');
    const owner = await userOf(tenantId, 'OWNER');

    // One — the owner. The count is the positive control that linking ran.
    expect(await linkUsersToRoles(prisma, tenantId)).toBe(1);
    expect(await roleIdOf(owner)).not.toBeNull();
    expect(await roleIdOf(salesperson)).toBeNull();
    expect(
      await prisma.role.findUnique({ where: { tenantId_key: { tenantId, key: 'SALESPERSON' } } }),
    ).toBeNull();
  });

  it('NEGATIVE: never links to an archived row', async () => {
    const tenantId = await makeTenant('tnt_link_arch', 'link-arch');
    await syncPermissionCatalogue(prisma);
    // Created directly, as a seeded row archived by hand would be: the API
    // refuses to archive a built-in, so only an operator can produce this.
    // A user linked to an archived row fails closed, so linking to one would
    // be a lockout dressed up as a migration.
    await prisma.role.create({
      data: { tenantId, key: 'MANAGER', name: 'Manager', isSystem: true, isActive: false },
    });
    const manager = await userOf(tenantId, 'MANAGER');

    expect(await linkUsersToRoles(prisma, tenantId)).toBe(0);
    expect(await roleIdOf(manager)).toBeNull();

    // POSITIVE CONTROL on the same row: reactivated, it IS linked to — so it
    // was the archival, not the key or the tenant, that stopped it.
    await prisma.role.update({
      where: { tenantId_key: { tenantId, key: 'MANAGER' } },
      data: { isActive: true },
    });
    expect(await linkUsersToRoles(prisma, tenantId)).toBe(1);
    expect(await roleIdOf(manager)).not.toBeNull();
  });

  it('NEGATIVE: never links to a tenant-created row under an enum key, even an active one', async () => {
    const tenantId = await makeTenant('tnt_link_custom', 'link-custom');
    await syncPermissionCatalogue(prisma);
    // Created directly: the API reserves the key now (D108), but a row from
    // before it did can still carry it. It is not the built-in, and linking
    // to it would hand the user THAT row's permissions — "something
    // approximate", which the contract rules out.
    await prisma.role.create({
      data: { tenantId, key: 'MANAGER', name: 'Manager', isSystem: false, isActive: true },
    });
    const manager = await userOf(tenantId, 'MANAGER');

    expect(await linkUsersToRoles(prisma, tenantId)).toBe(0);
    expect(await roleIdOf(manager)).toBeNull();

    // POSITIVE CONTROL on the same row: marked as seeded, it IS linked to.
    await prisma.role.update({
      where: { tenantId_key: { tenantId, key: 'MANAGER' } },
      data: { isSystem: true },
    });
    expect(await linkUsersToRoles(prisma, tenantId)).toBe(1);
    expect(await roleIdOf(manager)).not.toBeNull();
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
