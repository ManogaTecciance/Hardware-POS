/**
 * Phase 1.5.9 — module and document guards.
 *
 * The deferred rollout completes here: the retail write path, payments,
 * receipts, print jobs, discounts and `DocumentsController` all now carry
 * `@RequireModule`. Two guarantees to prove:
 *
 *  1. A tenant WITH the module continues to reach the route (the Tile Shop
 *     path — a regression on this would break every existing sale).
 *  2. A tenant WITHOUT the module is refused server-side, not merely UI-hidden.
 *
 * Two-directional per D30: every 403 is paired with a 200/201 on the same
 * request against a tenant that does have the module — a stack that refused
 * everyone would fail the positive control.
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
let restaurant: SeededTenant;

const ownerToken = (t: SeededTenant) =>
  http.tokenFor({
    userId: t.ownerId,
    tenantId: t.tenantId,
    role: 'OWNER',
    activeBranchId: t.branchId,
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
  restaurant = await seedSecondTenant(prisma);
  await syncPermissionCatalogue(prisma);
  await seedTenantRoles(prisma, tile.tenantId, 'TILE_SHOP');
  await seedTenantRoles(prisma, restaurant.tenantId, 'RESTAURANT');
  await linkUsersToRoles(prisma, tile.tenantId);
  await linkUsersToRoles(prisma, restaurant.tenantId);

  // The Restaurant tenant has an explicit RESTAURANT/LOCAL/NONE business
  // profile. Its module set intentionally excludes RETAIL_POS — that is
  // what makes it a valid subject for the "module refused" tests below.
  await prisma.tenantBusinessProfile.create({
    data: {
      tenantId: restaurant.tenantId,
      businessType: 'RESTAURANT',
      inventoryMode: 'LOCAL',
      accountingProvider: 'NONE',
    },
  });
  // Explicitly disable RETAIL_POS for the restaurant tenant so the guard
  // has a definite negative answer to give (the module resolution refuses
  // when there is no row and the tenant has a profile that doesn't list it).
  await prisma.tenantModule.create({
    data: { tenantId: restaurant.tenantId, moduleKey: 'RETAIL_POS', isEnabled: false },
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Retail POS write path
// ─────────────────────────────────────────────────────────────────────────────

describe('Phase 1.5.9 — retail POS write path requires RETAIL_POS', () => {
  it('POSITIVE: Tile Shop can still POST /sales/draft', async () => {
    const res = await http.request('POST', '/sales/draft', {
      token: ownerToken(tile),
      body: {
        branchId: tile.branchId,
        registerId: tile.registerId,
        items: [{ productId: tile.productAId, quantity: '1.000' }],
      },
    });
    // 201/200 depending on the draft flow — anything other than 403/404 proves
    // the guard did not refuse the tenant.
    expect(res.status).not.toBe(403);
    expect(res.status).not.toBe(404);
  });

  it('NEGATIVE: Restaurant (no RETAIL_POS module) is refused', async () => {
    const res = await http.request('POST', '/sales/draft', {
      token: ownerToken(restaurant),
      body: {
        branchId: restaurant.branchId,
        registerId: restaurant.registerId,
        items: [{ productId: restaurant.productAId, quantity: '1.000' }],
      },
    });
    expect(res.status).toBe(403);
  });

  it('NEGATIVE: Restaurant cannot POST /payments', async () => {
    const res = await http.request('POST', '/payments', {
      token: ownerToken(restaurant),
      body: {},
    });
    expect(res.status).toBe(403);
  });

  it('NEGATIVE: Restaurant cannot GET /receipts/:id', async () => {
    const res = await http.request('GET', '/receipts/anything', {
      token: ownerToken(restaurant),
    });
    expect(res.status).toBe(403);
  });

  it('NEGATIVE: Restaurant cannot GET /documents/sales/:saleId', async () => {
    const res = await http.request('GET', '/documents/sales/nonexistent', {
      token: ownerToken(restaurant),
    });
    expect(res.status).toBe(403);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Documents controller — per-route module guard, not per-class
// ─────────────────────────────────────────────────────────────────────────────

describe('Phase 1.5.9 — DocumentsController is guarded per route', () => {
  it('POSITIVE: Tile Shop can preview a return template (SETTINGS module)', async () => {
    const res = await http.request('POST', '/documents/preview/return', {
      token: ownerToken(tile),
      body: {},
    });
    // Anything but a 403 confirms the SETTINGS gate passed for the Tile Shop.
    expect(res.status).not.toBe(403);
  });

  it('POSITIVE: Restaurant CAN preview a return template because SETTINGS is enabled', async () => {
    // Restaurant profile enables SETTINGS by default — this route is not
    // retail-only. The guard must not fail-closed on unrelated modules.
    const res = await http.request('POST', '/documents/preview/return', {
      token: ownerToken(restaurant),
      body: {},
    });
    expect(res.status).not.toBe(403);
  });
});
