/**
 * Platform business profile — over real HTTP, against real PostgreSQL.
 *
 * Everything here goes through the wire on purpose. The properties under test are
 * properties of the *wiring*: a 403 for a cashier comes from the global
 * `PermissionsGuard`, a 400 for an unknown module key comes from the global
 * `ValidationPipe`, and tenant isolation comes from `@TenantId()` reading a
 * verified JWT. None of those exist when a service is called directly, so a
 * service-level spec would assert nothing about the guarantee it claims to cover.
 *
 * Access tokens are minted with the app's own `JwtService` using the same claims
 * `AuthService.issueToken` signs, so requests are indistinguishable from a real
 * logged-in session.
 */

import {
  AccountingProviderKind,
  BusinessType,
  InventoryMode,
  ModuleKey,
  type PrismaClient,
  type UserRole,
} from '@hardware-pos/database';

import { connectTestPrisma, disconnectTestPrisma } from '../prisma-test-client';
import { resetDatabase } from '../db-reset';
import { seedSecondTenant, seedTileShopWithQuickBooks, type SeededTenant } from '../fixtures';
import { createHttpIntegrationApp, type HttpIntegrationApp } from '../http-test-app';
import { BusinessProfileRepository } from '../../../src/modules/platform/business-profile.repository';
import { LEGACY_TENANT_DEFAULTS } from '../../../src/modules/platform/platform.constants';
import type { EffectiveBusinessProfile, ModuleState } from '../../../src/modules/platform/platform.types';

let prisma: PrismaClient;
let http: HttpIntegrationApp;
let tile: SeededTenant;
let other: SeededTenant;

/** The explicit Restaurant profile from the Product Owner's Slice 4 brief. */
const RESTAURANT_PROFILE = {
  businessType: BusinessType.RESTAURANT,
  inventoryMode: InventoryMode.LOCAL,
  accountingProvider: AccountingProviderKind.NONE,
  enabledModules: [
    ModuleKey.MENU_MANAGEMENT,
    ModuleKey.DINING,
    ModuleKey.TABLE_MANAGEMENT,
    ModuleKey.TAKEAWAY,
    ModuleKey.KITCHEN,
    ModuleKey.CUSTOMERS,
    ModuleKey.REPORTING,
    ModuleKey.USERS,
    ModuleKey.BRANCHES,
    ModuleKey.SETTINGS,
    ModuleKey.BRANDING,
  ],
} as const;

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
});

/**
 * Create a real `User` row for a role the shared fixture does not seed, so the
 * audit-log foreign key is satisfiable on the success paths.
 */
async function userWithRole(tenant: SeededTenant, role: UserRole): Promise<string> {
  const id = `${tenant.tenantId}-${role.toLowerCase()}`;
  await prisma.user.create({
    data: {
      id,
      tenantId: tenant.tenantId,
      branchId: tenant.branchId,
      role,
      name: `Fixture ${role}`,
      email: `${role.toLowerCase()}.platform@${tenant.tenantId}.test`,
    },
  });
  return id;
}

function tokenFor(tenant: SeededTenant, userId: string, role: UserRole): string {
  return http.tokenFor({ userId, tenantId: tenant.tenantId, role });
}

function ownerToken(tenant: SeededTenant): string {
  return tokenFor(tenant, tenant.ownerId, 'OWNER');
}

function getProfile(token: string) {
  return http.request<EffectiveBusinessProfile>('GET', '/platform/profile', { token });
}

function patchProfile(token: string, body: unknown) {
  return http.request<EffectiveBusinessProfile>('PATCH', '/platform/profile', { token, body });
}

// ─────────────────────────────────────────────────────────────────────────────
// 1 — legacy defaults
// ─────────────────────────────────────────────────────────────────────────────

describe('a tenant with no profile row', () => {
  it('resolves the legacy Tile Shop configuration, reported as LEGACY_DEFAULT', async () => {
    const res = await getProfile(ownerToken(tile));

    expect(res.status).toBe(200);
    expect(res.data.source).toBe('LEGACY_DEFAULT');
    expect(res.data.businessType).toBe(BusinessType.HARDWARE);
    expect(res.data.inventoryMode).toBe(InventoryMode.QUICKBOOKS);
    expect(res.data.accountingProvider).toBe(AccountingProviderKind.QUICKBOOKS);
  });

  it('writes nothing to the database just by being read', async () => {
    await getProfile(ownerToken(tile));

    // The compatibility contract: no row is created lazily, so an existing tenant
    // is never silently migrated into an explicit profile by ordinary traffic.
    expect(await prisma.tenantBusinessProfile.count()).toBe(0);
    expect(await prisma.tenantModule.count()).toBe(0);
  });

  it('preserves every current Tile Shop route', async () => {
    const res = await getProfile(ownerToken(tile));

    expect([...res.data.enabledModules].sort()).toEqual(
      [...LEGACY_TENANT_DEFAULTS.enabledModules].sort(),
    );
  });

  it.each([
    ['the retail POS', ModuleKey.RETAIL_POS],
    ['inventory', ModuleKey.INVENTORY],
    ['quotations', ModuleKey.QUOTATIONS],
    ['returns', ModuleKey.RETURNS],
    ['exchange document rendering', ModuleKey.EXCHANGES],
    ['suppliers', ModuleKey.SUPPLIERS],
    ['customers', ModuleKey.CUSTOMERS],
    ['reports', ModuleKey.REPORTING],
    ['users', ModuleKey.USERS],
    ['branches', ModuleKey.BRANCHES],
    ['settings', ModuleKey.SETTINGS],
    ['branding', ModuleKey.BRANDING],
    ['QuickBooks', ModuleKey.QUICKBOOKS],
  ])('keeps %s enabled', async (_label, moduleKey) => {
    const res = await getProfile(ownerToken(tile));
    expect(res.data.enabledModules).toContain(moduleKey);
  });

  it('reports no version — there is no row to version', async () => {
    const res = await getProfile(ownerToken(tile));
    expect(res.data.version).toBeNull();
  });

  it('does not require QuickBooks to be reconnected — the existing connection is untouched', async () => {
    const before = await prisma.quickBooksConnection.findUniqueOrThrow({
      where: { tenantId: tile.tenantId },
    });
    await getProfile(ownerToken(tile));
    const after = await prisma.quickBooksConnection.findUniqueOrThrow({
      where: { tenantId: tile.tenantId },
    });

    expect(after).toEqual(before);
    expect(after.isActive).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6-9 — the explicit Restaurant profile
// ─────────────────────────────────────────────────────────────────────────────

describe('an explicit Restaurant profile', () => {
  it('can be created with LOCAL inventory and NONE accounting', async () => {
    const res = await patchProfile(ownerToken(other), RESTAURANT_PROFILE);

    expect(res.status).toBe(200);
    expect(res.data.source).toBe('EXPLICIT');
    expect(res.data.businessType).toBe(BusinessType.RESTAURANT);
    expect(res.data.inventoryMode).toBe(InventoryMode.LOCAL);
    expect(res.data.accountingProvider).toBe(AccountingProviderKind.NONE);
  });

  it('enables exactly the requested modules', async () => {
    const res = await patchProfile(ownerToken(other), RESTAURANT_PROFILE);

    expect([...res.data.enabledModules].sort()).toEqual([...RESTAURANT_PROFILE.enabledModules].sort());
  });

  it.each([
    ['QUOTATIONS', ModuleKey.QUOTATIONS],
    ['RETURNS', ModuleKey.RETURNS],
    ['SUPPLIERS', ModuleKey.SUPPLIERS],
    ['QUICKBOOKS', ModuleKey.QUICKBOOKS],
    ['EXCHANGES', ModuleKey.EXCHANGES],
  ])('does not enable %s', async (_label, moduleKey) => {
    const res = await patchProfile(ownerToken(other), RESTAURANT_PROFILE);
    expect(res.data.enabledModules).not.toContain(moduleKey);
  });

  it('creates NO QuickBooks connection', async () => {
    await patchProfile(ownerToken(other), RESTAURANT_PROFILE);

    expect(
      await prisma.quickBooksConnection.count({ where: { tenantId: other.tenantId } }),
    ).toBe(0);
  });

  it('creates NO QuickBooks SyncJob', async () => {
    await patchProfile(ownerToken(other), RESTAURANT_PROFILE);

    expect(await prisma.syncJob.count({ where: { tenantId: other.tenantId } })).toBe(0);
    // Nor for anyone else — a profile write must not touch another tenant's queue.
    expect(await prisma.syncJob.count()).toBe(0);
  });

  it('creates NO QuickBooks SyncLog', async () => {
    await patchProfile(ownerToken(other), RESTAURANT_PROFILE);

    expect(await prisma.syncLog.count({ where: { tenantId: other.tenantId } })).toBe(0);
    expect(await prisma.syncLog.count()).toBe(0);
  });

  it('creates NO QuickBooks mapping rows', async () => {
    await patchProfile(ownerToken(other), RESTAURANT_PROFILE);
    expect(await prisma.quickBooksMapping.count()).toBe(0);
  });

  it('returns a response body containing no QuickBooks document id', async () => {
    const res = await patchProfile(ownerToken(other), RESTAURANT_PROFILE);

    const serialised = JSON.stringify(res.body);
    expect(serialised).not.toMatch(/quickbooks[A-Za-z]*Id/i);
    expect(serialised).not.toMatch(/realmId/i);
    expect(Object.keys(res.data)).toEqual([
      'source',
      'businessType',
      'inventoryMode',
      'accountingProvider',
      'enabledModules',
      // D56 — capabilities resolved from the domain registry.
      'capabilities',
      'version',
      'updatedAt',
    ]);
  });

  it('setting the profile does not create OR delete any tables — schema is stable', async () => {
    // Originally: "creates no restaurant operational rows — the domain does
    // not exist yet". After Restaurant Phase 2 (2A-2D), Phase 2.5 and Phase
    // 6, all the tables the plan called for exist. What still holds is that
    // *setting the profile* is a data change only — it must not create,
    // drop or alter any schema table. The alt-name `DiningTable` must
    // never appear either way.
    const tablesBefore = await prisma.$queryRaw<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'
    `;
    const before = tablesBefore.map((row) => row.table_name).sort();

    await patchProfile(ownerToken(other), RESTAURANT_PROFILE);

    const tablesAfter = await prisma.$queryRaw<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'
    `;
    const after = tablesAfter.map((row) => row.table_name).sort();

    // Schema is byte-for-byte identical either side of the profile change.
    expect(after).toEqual(before);
    // POSITIVE CONTROL: the query did return the schema.
    expect(after).toContain('Sale');
    expect(after).toContain('TenantBusinessProfile');
    expect(after).toContain('RestaurantOrder');
    expect(after).toContain('BranchInventory');
    expect(after.length).toBeGreaterThan(20);
    // Negative: alternative names must never appear.
    expect(after).not.toContain('DiningTable');
    expect(after).not.toContain('InventoryBalance');
  });

  it('leaves the OTHER tenant on the legacy default', async () => {
    await patchProfile(ownerToken(other), RESTAURANT_PROFILE);

    const tileProfile = await getProfile(ownerToken(tile));
    expect(tileProfile.data.source).toBe('LEGACY_DEFAULT');
    expect(tileProfile.data.businessType).toBe(BusinessType.HARDWARE);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10-11 — tenant isolation
// ─────────────────────────────────────────────────────────────────────────────

describe('tenant isolation', () => {
  beforeEach(async () => {
    await patchProfile(ownerToken(other), RESTAURANT_PROFILE);
  });

  it("tenant A cannot read tenant B's explicit profile", async () => {
    const res = await getProfile(ownerToken(tile));

    // Tile's own answer, never the restaurant's.
    expect(res.data.source).toBe('LEGACY_DEFAULT');
    expect(res.data.businessType).toBe(BusinessType.HARDWARE);
    expect(res.data.inventoryMode).not.toBe(InventoryMode.LOCAL);
  });

  it('an x-tenant-id header naming the other tenant is ignored — the session wins', async () => {
    const res = await http.request<EffectiveBusinessProfile>('GET', '/platform/profile', {
      token: ownerToken(tile),
      headers: { 'x-tenant-id': other.tenantId },
    });

    expect(res.status).toBe(200);
    expect(res.data.source).toBe('LEGACY_DEFAULT');
    expect(res.data.businessType).toBe(BusinessType.HARDWARE);
  });

  it("tenant A cannot update tenant B's profile via a header", async () => {
    await patchProfile(ownerToken(tile), { businessType: BusinessType.HARDWARE });

    const restaurant = await prisma.tenantBusinessProfile.findUniqueOrThrow({
      where: { tenantId: other.tenantId },
    });
    expect(restaurant.businessType).toBe(BusinessType.RESTAURANT);
  });

  it("tenant A cannot update tenant B's profile via a body field — the field is rejected outright", async () => {
    const res = await http.request('PATCH', '/platform/profile', {
      token: ownerToken(tile),
      body: { tenantId: other.tenantId, businessType: BusinessType.CAFE },
    });

    // `forbidNonWhitelisted` turns an unexpected field into a 400 rather than
    // silently dropping it, so a client attempting this gets told, loudly.
    expect(res.status).toBe(400);
    const restaurant = await prisma.tenantBusinessProfile.findUniqueOrThrow({
      where: { tenantId: other.tenantId },
    });
    expect(restaurant.businessType).toBe(BusinessType.RESTAURANT);
  });

  it('writes land on the authenticated tenant only', async () => {
    await patchProfile(ownerToken(tile), { businessType: BusinessType.HARDWARE });

    expect(await prisma.tenantBusinessProfile.count()).toBe(2);
    const tileProfile = await prisma.tenantBusinessProfile.findUniqueOrThrow({
      where: { tenantId: tile.tenantId },
    });
    expect(tileProfile.businessType).toBe(BusinessType.HARDWARE);
  });

  it("module rows never cross tenants", async () => {
    const rows = await prisma.tenantModule.findMany();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.tenantId === other.tenantId)).toBe(true);
  });

  it('an unauthenticated request is rejected before any tenant is resolved', async () => {
    expect((await http.request('GET', '/platform/profile')).status).toBe(401);
    expect((await http.request('PATCH', '/platform/profile', { body: {} })).status).toBe(401);
  });

  it('a token signed with the wrong secret cannot name a tenant', async () => {
    const forged = [
      Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
      Buffer.from(
        JSON.stringify({ sub: other.ownerId, tenantId: other.tenantId, role: 'OWNER' }),
      ).toString('base64url'),
      'not-a-real-signature',
    ].join('.');

    expect((await getProfile(forged)).status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 12-16 — permission enforcement
// ─────────────────────────────────────────────────────────────────────────────

describe('permission enforcement on PATCH', () => {
  it.each([['CASHIER'], ['MANAGER'], ['ACCOUNTANT']] as const)(
    '%s cannot update the platform profile',
    async (role) => {
      const userId = role === 'CASHIER' ? tile.cashierId : await userWithRole(tile, role);
      const token = tokenFor(tile, userId, role);

      const res = await patchProfile(token, { businessType: BusinessType.RESTAURANT });

      expect(res.status).toBe(403);
      expect(await prisma.tenantBusinessProfile.count()).toBe(0);
    },
  );

  it('MANAGER cannot update even when the fixture manager id is used', async () => {
    const res = await patchProfile(tokenFor(tile, tile.managerId, 'MANAGER'), {
      inventoryMode: InventoryMode.LOCAL,
    });

    expect(res.status).toBe(403);
    expect(await prisma.tenantBusinessProfile.count()).toBe(0);
  });

  it.each([['OWNER'], ['ADMIN']] as const)('%s can update its own tenant profile', async (role) => {
    const userId = role === 'OWNER' ? tile.ownerId : await userWithRole(tile, role);
    const token = tokenFor(tile, userId, role);

    const res = await patchProfile(token, { businessType: BusinessType.HARDWARE });

    expect(res.status).toBe(200);
    expect(res.data.businessType).toBe(BusinessType.HARDWARE);
  });

  it.each([['OWNER'], ['ADMIN'], ['MANAGER'], ['ACCOUNTANT'], ['CASHIER']] as const)(
    '%s can read the effective profile — navigation depends on it',
    async (role) => {
      const userId =
        role === 'OWNER'
          ? tile.ownerId
          : role === 'MANAGER'
            ? tile.managerId
            : role === 'CASHIER'
              ? tile.cashierId
              : await userWithRole(tile, role);

      const res = await getProfile(tokenFor(tile, userId, role));
      expect(res.status).toBe(200);
    },
  );

  it('records an audit entry on a successful update', async () => {
    await patchProfile(ownerToken(tile), { businessType: BusinessType.HARDWARE });

    const entries = await prisma.auditLog.findMany({ where: { tenantId: tile.tenantId } });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      action: 'platform_profile.updated',
      entityType: 'TenantBusinessProfile',
      entityId: tile.tenantId,
      userId: tile.ownerId,
    });
  });

  it('records NO audit entry on a rejected update', async () => {
    await patchProfile(tokenFor(tile, tile.cashierId, 'CASHIER'), {
      businessType: BusinessType.RESTAURANT,
    });

    expect(await prisma.auditLog.count()).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 17-19 — validation, uniqueness, transactionality
// ─────────────────────────────────────────────────────────────────────────────

describe('validation', () => {
  it.each([
    ['an unknown module key', { enabledModules: ['NOT_A_MODULE'] }],
    ['a lowercase module key', { enabledModules: ['dining'] }],
    ['PAYMENTS, which is deliberately not a module', { enabledModules: ['PAYMENTS'] }],
    ['a non-array module list', { enabledModules: 'DINING' }],
    ['an unknown business type', { businessType: 'FOOD_TRUCK' }],
    ['an unknown inventory mode', { inventoryMode: 'MAGIC' }],
    ['an unknown accounting provider', { accountingProvider: 'XERO' }],
    ['an unexpected extra field', { somethingElse: true }],
  ])('rejects %s with 400', async (_label, body) => {
    const res = await patchProfile(ownerToken(tile), body);

    expect(res.status).toBe(400);
    expect(await prisma.tenantBusinessProfile.count()).toBe(0);
    expect(await prisma.tenantModule.count()).toBe(0);
  });

  it('rejects a duplicated module key rather than silently absorbing it', async () => {
    const res = await patchProfile(ownerToken(tile), {
      enabledModules: [ModuleKey.DINING, ModuleKey.DINING],
    });

    expect(res.status).toBe(400);
  });

  it('accepts an empty update as a no-op that still creates the row', async () => {
    const res = await patchProfile(ownerToken(tile), {});

    expect(res.status).toBe(200);
    // A first write with nothing specified must land on the tenant's CURRENT
    // effective configuration, not on an arbitrary default.
    expect(res.data.businessType).toBe(LEGACY_TENANT_DEFAULTS.businessType);
    expect(res.data.inventoryMode).toBe(LEGACY_TENANT_DEFAULTS.inventoryMode);
    expect(res.data.accountingProvider).toBe(LEGACY_TENANT_DEFAULTS.accountingProvider);
  });
});

describe('duplicate TenantModule rows are prevented', () => {
  it('the database rejects a second row for the same (tenant, module)', async () => {
    await prisma.tenantModule.create({
      data: { tenantId: tile.tenantId, moduleKey: ModuleKey.DINING, isEnabled: true },
    });

    await expect(
      prisma.tenantModule.create({
        data: { tenantId: tile.tenantId, moduleKey: ModuleKey.DINING, isEnabled: false },
      }),
    ).rejects.toThrow(/Unique constraint/i);
  });

  it('the same module in two different tenants is fine', async () => {
    await prisma.tenantModule.create({
      data: { tenantId: tile.tenantId, moduleKey: ModuleKey.DINING, isEnabled: true },
    });
    await expect(
      prisma.tenantModule.create({
        data: { tenantId: other.tenantId, moduleKey: ModuleKey.DINING, isEnabled: true },
      }),
    ).resolves.toBeDefined();
  });

  it('repeated PATCHes never accumulate duplicate rows', async () => {
    for (let i = 0; i < 4; i += 1) {
      await patchProfile(ownerToken(tile), RESTAURANT_PROFILE);
    }

    const rows = await prisma.tenantModule.findMany({ where: { tenantId: tile.tenantId } });
    const keys = rows.map((row) => row.moduleKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('the database rejects a second profile row for one tenant', async () => {
    await prisma.tenantBusinessProfile.create({
      data: {
        tenantId: tile.tenantId,
        businessType: BusinessType.HARDWARE,
        inventoryMode: InventoryMode.LOCAL,
        accountingProvider: AccountingProviderKind.NONE,
      },
    });

    await expect(
      prisma.tenantBusinessProfile.create({
        data: {
          tenantId: tile.tenantId,
          businessType: BusinessType.CAFE,
          inventoryMode: InventoryMode.LOCAL,
          accountingProvider: AccountingProviderKind.NONE,
        },
      }),
    ).rejects.toThrow(/Unique constraint/i);
  });
});

describe('a failed module update rolls back the whole profile transaction', () => {
  it('leaves neither the profile nor the modules changed when validation rejects the request', async () => {
    await patchProfile(ownerToken(tile), {
      businessType: BusinessType.HARDWARE,
      enabledModules: [ModuleKey.RETAIL_POS, ModuleKey.INVENTORY],
    });
    const before = await prisma.tenantBusinessProfile.findUniqueOrThrow({
      where: { tenantId: tile.tenantId },
    });
    const modulesBefore = await prisma.tenantModule.findMany({
      where: { tenantId: tile.tenantId },
      orderBy: { moduleKey: 'asc' },
    });

    const res = await patchProfile(ownerToken(tile), {
      businessType: BusinessType.RESTAURANT,
      enabledModules: [ModuleKey.DINING, 'NOT_A_MODULE'],
    });

    expect(res.status).toBe(400);
    const after = await prisma.tenantBusinessProfile.findUniqueOrThrow({
      where: { tenantId: tile.tenantId },
    });
    // The business type must NOT have moved to RESTAURANT while the module list
    // stayed retail — that half-applied state is the failure mode being excluded.
    expect(after.businessType).toBe(BusinessType.HARDWARE);
    expect(after.version).toBe(before.version);
    expect(
      await prisma.tenantModule.findMany({
        where: { tenantId: tile.tenantId },
        orderBy: { moduleKey: 'asc' },
      }),
    ).toEqual(modulesBefore);
  });

  /**
   * The case validation cannot produce: a failure that happens AFTER the profile
   * row has already been written, while the module rows are being written.
   *
   * Provoked honestly rather than by stubbing a private method — the repository
   * takes the default-module lookup as a callback, so a throwing callback fails
   * inside the transaction at exactly the point of interest. If the profile write
   * and the module writes were not in one transaction, the business type would
   * survive and this test would fail.
   */
  it('rolls back the profile write when the module write fails mid-transaction', async () => {
    await patchProfile(ownerToken(tile), { businessType: BusinessType.HARDWARE });
    const before = await prisma.tenantBusinessProfile.findUniqueOrThrow({
      where: { tenantId: tile.tenantId },
    });

    const repository = http.app.get(BusinessProfileRepository);
    await expect(
      repository.upsertProfile(
        tile.tenantId,
        { businessType: BusinessType.CAFE },
        [ModuleKey.DINING],
        () => {
          throw new Error('simulated failure while resolving default modules');
        },
      ),
    ).rejects.toThrow('simulated failure while resolving default modules');

    const after = await prisma.tenantBusinessProfile.findUniqueOrThrow({
      where: { tenantId: tile.tenantId },
    });
    // The business type must NOT be CAFE with no module rows — that half-applied
    // state is precisely what the transaction exists to prevent.
    expect(after.businessType).toBe(BusinessType.HARDWARE);
    expect(after.version).toBe(before.version);
    expect(after.updatedAt).toEqual(before.updatedAt);
    expect(await prisma.tenantModule.count({ where: { tenantId: tile.tenantId } })).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Profile lifecycle
// ─────────────────────────────────────────────────────────────────────────────

describe('profile lifecycle', () => {
  it('increments version on every update — an optimistic-concurrency token', async () => {
    const first = await patchProfile(ownerToken(tile), { businessType: BusinessType.HARDWARE });
    const second = await patchProfile(ownerToken(tile), { businessType: BusinessType.HARDWARE });

    expect(first.data.version).toBe(1);
    expect(second.data.version).toBe(2);
  });

  it('a partial update leaves untouched fields alone', async () => {
    await patchProfile(ownerToken(tile), RESTAURANT_PROFILE);
    const res = await patchProfile(ownerToken(tile), { businessType: BusinessType.CAFE });

    expect(res.data.businessType).toBe(BusinessType.CAFE);
    expect(res.data.inventoryMode).toBe(InventoryMode.LOCAL);
    expect(res.data.accountingProvider).toBe(AccountingProviderKind.NONE);
  });

  it('omitting enabledModules leaves module configuration untouched', async () => {
    await patchProfile(ownerToken(tile), RESTAURANT_PROFILE);
    const before = await prisma.tenantModule.findMany({
      where: { tenantId: tile.tenantId },
      orderBy: { moduleKey: 'asc' },
      select: { moduleKey: true, isEnabled: true },
    });

    await patchProfile(ownerToken(tile), { inventoryMode: InventoryMode.DISABLED });

    expect(
      await prisma.tenantModule.findMany({
        where: { tenantId: tile.tenantId },
        orderBy: { moduleKey: 'asc' },
        select: { moduleKey: true, isEnabled: true },
      }),
    ).toEqual(before);
  });

  it('an explicitly revoked module stays revoked', async () => {
    await patchProfile(ownerToken(tile), RESTAURANT_PROFILE);
    const withoutDining = RESTAURANT_PROFILE.enabledModules.filter(
      (key) => key !== ModuleKey.DINING,
    );

    const res = await patchProfile(ownerToken(tile), { enabledModules: withoutDining });

    expect(res.data.enabledModules).not.toContain(ModuleKey.DINING);
    const row = await prisma.tenantModule.findUniqueOrThrow({
      where: { tenantId_moduleKey: { tenantId: tile.tenantId, moduleKey: ModuleKey.DINING } },
    });
    // Recorded as a stated `false`, not deleted — "off" must survive as a fact,
    // or the business-type default would silently switch it back on.
    expect(row.isEnabled).toBe(false);
  });

  it('cascades away with its tenant', async () => {
    await patchProfile(ownerToken(other), RESTAURANT_PROFILE);
    expect(await prisma.tenantBusinessProfile.count({ where: { tenantId: other.tenantId } })).toBe(1);

    await prisma.tenant.delete({ where: { id: other.tenantId } });

    expect(await prisma.tenantBusinessProfile.count({ where: { tenantId: other.tenantId } })).toBe(0);
    expect(await prisma.tenantModule.count({ where: { tenantId: other.tenantId } })).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /platform/modules
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /platform/modules', () => {
  it('lists the legacy retail modules as enabled but not explicit', async () => {
    const res = await http.request<ModuleState[]>('GET', '/platform/modules', {
      token: ownerToken(tile),
    });

    expect(res.status).toBe(200);
    const quotations = res.data.find((row) => row.moduleKey === ModuleKey.QUOTATIONS);
    expect(quotations).toEqual({
      moduleKey: ModuleKey.QUOTATIONS,
      isEnabled: true,
      isExplicit: false,
    });
  });

  it('distinguishes an explicitly disabled module', async () => {
    await patchProfile(ownerToken(other), RESTAURANT_PROFILE);
    const withoutKitchen = RESTAURANT_PROFILE.enabledModules.filter(
      (key) => key !== ModuleKey.KITCHEN,
    );
    await patchProfile(ownerToken(other), { enabledModules: withoutKitchen });

    const res = await http.request<ModuleState[]>('GET', '/platform/modules', {
      token: ownerToken(other),
    });

    expect(res.data.find((row) => row.moduleKey === ModuleKey.KITCHEN)).toEqual({
      moduleKey: ModuleKey.KITCHEN,
      isEnabled: false,
      isExplicit: true,
    });
  });

  it('is scoped to the authenticated tenant', async () => {
    await patchProfile(ownerToken(other), RESTAURANT_PROFILE);

    const res = await http.request<ModuleState[]>('GET', '/platform/modules', {
      token: ownerToken(tile),
    });

    const keys = res.data.map((row) => row.moduleKey);
    expect(keys).not.toContain(ModuleKey.DINING);
    // POSITIVE CONTROL: the response really is this tenant's module list, so the
    // absence above means "not enabled here" rather than "empty response".
    expect(keys.length).toBeGreaterThan(0);
    expect(keys).toContain(ModuleKey.RETAIL_POS);
  });
});
