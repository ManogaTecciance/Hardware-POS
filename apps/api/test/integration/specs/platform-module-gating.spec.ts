/**
 * `@RequireModule` / `ModuleAccessGuard` over real HTTP.
 *
 * `QuotationsController` is the one live controller Slice 4 gates, so these tests
 * exercise the real guard, registered as a real `APP_GUARD`, on a real route,
 * against a real database — not a fabricated `ExecutionContext`.
 *
 * The two assertions that matter most:
 *
 *   • a tenant with NO business profile still reaches `/v1/quotations` — adding a
 *     global guard must not have changed a single existing Tile Shop route;
 *   • a tenant whose profile does not include `QUOTATIONS` gets 403 even though
 *     its user holds `QUOTATION_READ`, because role permission and tenant module
 *     configuration are separate questions.
 */

import {
  AccountingProviderKind,
  BusinessType,
  InventoryMode,
  ModuleKey,
  type PrismaClient,
} from '@hardware-pos/database';

import { connectTestPrisma, disconnectTestPrisma } from '../prisma-test-client';
import { resetDatabase } from '../db-reset';
import { seedSecondTenant, seedTileShopWithQuickBooks, type SeededTenant } from '../fixtures';
import { createHttpIntegrationApp, type HttpIntegrationApp } from '../http-test-app';

let prisma: PrismaClient;
let http: HttpIntegrationApp;
let tile: SeededTenant;
let restaurant: SeededTenant;

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
  restaurant = await seedSecondTenant(prisma);
});

function ownerToken(tenant: SeededTenant): string {
  return http.tokenFor({ userId: tenant.ownerId, tenantId: tenant.tenantId, role: 'OWNER' });
}

/** Write an explicit profile straight to the database — no HTTP round trip needed. */
async function giveProfile(
  tenant: SeededTenant,
  businessType: BusinessType,
  modules: { moduleKey: ModuleKey; isEnabled: boolean }[] = [],
): Promise<void> {
  await prisma.tenantBusinessProfile.create({
    data: {
      tenantId: tenant.tenantId,
      businessType,
      inventoryMode: InventoryMode.LOCAL,
      accountingProvider: AccountingProviderKind.NONE,
    },
  });
  for (const module of modules) {
    await prisma.tenantModule.create({ data: { tenantId: tenant.tenantId, ...module } });
  }
}

function listQuotations(tenant: SeededTenant) {
  return http.request('GET', '/quotations', { token: ownerToken(tenant) });
}

// ─────────────────────────────────────────────────────────────────────────────

describe('legacy default module resolution preserves current Tile Shop routes', () => {
  it('a tenant with NO profile row can still reach the gated quotations route', async () => {
    const res = await listQuotations(tile);

    expect(res.status).toBe(200);
    expect(await prisma.tenantBusinessProfile.count()).toBe(0);
  });

  it('stays reachable across repeated requests — the guard is not order-dependent', async () => {
    for (let i = 0; i < 5; i += 1) {
      expect((await listQuotations(tile)).status).toBe(200);
    }
  });

  it('an ungated route is unaffected either way', async () => {
    // /settings carries no @RequireModule, so the guard must wave it through for
    // both a legacy tenant and one with a restrictive explicit profile.
    expect((await http.request('GET', '/settings', { token: ownerToken(tile) })).status).toBe(200);

    await giveProfile(restaurant, BusinessType.RESTAURANT);
    expect(
      (await http.request('GET', '/settings', { token: ownerToken(restaurant) })).status,
    ).toBe(200);
  });
});

describe('the module guard allows an enabled module', () => {
  it('allows a RETAIL tenant, whose defaults include QUOTATIONS', async () => {
    await giveProfile(restaurant, BusinessType.HARDWARE);
    expect((await listQuotations(restaurant)).status).toBe(200);
  });

  it('allows a RESTAURANT tenant that has explicitly opted in to QUOTATIONS', async () => {
    await giveProfile(restaurant, BusinessType.RESTAURANT, [
      { moduleKey: ModuleKey.QUOTATIONS, isEnabled: true },
    ]);
    expect((await listQuotations(restaurant)).status).toBe(200);
  });
});

describe('the module guard rejects a disabled module', () => {
  it('rejects a RESTAURANT tenant, whose defaults exclude QUOTATIONS', async () => {
    await giveProfile(restaurant, BusinessType.RESTAURANT);

    const res = await listQuotations(restaurant);
    expect(res.status).toBe(403);
  });

  it('rejects a RETAIL tenant that has explicitly revoked QUOTATIONS', async () => {
    await giveProfile(restaurant, BusinessType.HARDWARE, [
      { moduleKey: ModuleKey.QUOTATIONS, isEnabled: false },
    ]);

    // A revocation must beat the business-type default, or turning a module off
    // would be impossible.
    expect((await listQuotations(restaurant)).status).toBe(403);
  });

  it('rejects with a generic message that does not disclose the module set', async () => {
    await giveProfile(restaurant, BusinessType.RESTAURANT);

    const res = await listQuotations(restaurant);
    expect(JSON.stringify(res.body)).toContain('Feature not available');
    expect(JSON.stringify(res.body)).not.toContain('QUOTATIONS');
  });

  it('rejects every method on the gated controller, not just the one that was tested', async () => {
    await giveProfile(restaurant, BusinessType.RESTAURANT);
    const token = ownerToken(restaurant);

    const responses = await Promise.all([
      http.request('GET', '/quotations', { token }),
      http.request('GET', '/quotations/qtn_does_not_exist', { token }),
      http.request('POST', '/quotations', { token, body: { items: [] } }),
      http.request('POST', '/quotations/preview', { token, body: { items: [] } }),
    ]);

    for (const res of responses) {
      expect(res.status).toBe(403);
    }
  });

  it('is enforced on the backend even though the front-end also hides navigation', async () => {
    await giveProfile(restaurant, BusinessType.RESTAURANT);

    // No client cooperation involved: a hand-made request with a perfectly valid
    // owner token for a tenant without the module is refused server-side.
    expect((await listQuotations(restaurant)).status).toBe(403);
    expect(await prisma.quotation.count()).toBe(0);
  });
});

describe('module gating is per tenant', () => {
  it('one tenant losing QUOTATIONS does not affect the other', async () => {
    await giveProfile(restaurant, BusinessType.RESTAURANT);

    expect((await listQuotations(restaurant)).status).toBe(403);
    expect((await listQuotations(tile)).status).toBe(200);
  });

  it('re-enabling the module restores access immediately — no cache to wait for', async () => {
    await giveProfile(restaurant, BusinessType.RESTAURANT);
    expect((await listQuotations(restaurant)).status).toBe(403);

    await prisma.tenantModule.create({
      data: { tenantId: restaurant.tenantId, moduleKey: ModuleKey.QUOTATIONS, isEnabled: true },
    });

    // Decision D11: the profile is an authorization input and is not cached across
    // requests, so a grant (or a revocation) takes effect on the very next call.
    expect((await listQuotations(restaurant)).status).toBe(200);
  });

  it('revoking the module takes effect immediately', async () => {
    await giveProfile(restaurant, BusinessType.HARDWARE);
    expect((await listQuotations(restaurant)).status).toBe(200);

    await prisma.tenantModule.create({
      data: { tenantId: restaurant.tenantId, moduleKey: ModuleKey.QUOTATIONS, isEnabled: false },
    });

    expect((await listQuotations(restaurant)).status).toBe(403);
  });
});
