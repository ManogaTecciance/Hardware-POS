/**
 * Restaurant Phase 2B — menu.
 *
 * Non-vacuous per D30: every positive claim (module gate passes, creation
 * succeeds) is paired with a negative (hardware tenant refused, duplicate
 * name refused, cross-tenant refs 404).
 */
import {
  seedTenantRoles,
  syncPermissionCatalogue,
  linkUsersToRoles,
} from '@hardware-pos/database';
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
  await prisma.tenantBusinessProfile.create({
    data: {
      tenantId: restaurant.tenantId,
      businessType: 'RESTAURANT',
      inventoryMode: 'LOCAL',
      accountingProvider: 'NONE',
    },
  });
});

describe('Restaurant Phase 2B — module gating', () => {
  it('a restaurant tenant can list menus', async () => {
    const res = await http.request('GET', `/restaurant/branches/${restaurant.branchId}/menus`, {
      token: ownerToken(restaurant),
    });
    expect(res.status).toBe(200);
    expect(res.data).toEqual([]);
  });

  it('a hardware tenant is refused 403', async () => {
    const res = await http.request('GET', `/restaurant/branches/${tile.branchId}/menus`, {
      token: ownerToken(tile),
    });
    expect(res.status).toBe(403);
  });
});

describe('Restaurant Phase 2B — menu lifecycle', () => {
  it('creates a menu, section, and item', async () => {
    const menu = await http.request<{ id: string; version: number }>(
      'POST',
      `/restaurant/branches/${restaurant.branchId}/menus`,
      { token: ownerToken(restaurant), body: { name: 'Lunch Menu' } },
    );
    expect(menu.status).toBe(201);
    expect(menu.data.version).toBe(1);

    const section = await http.request<{ id: string; name: string }>(
      'POST',
      `/restaurant/menus/${menu.data.id}/sections`,
      { token: ownerToken(restaurant), body: { name: 'Mains', position: 1 } },
    );
    expect(section.status).toBe(201);

    const item = await http.request<{ id: string; basePrice: string; sectionId: string }>(
      'POST',
      `/restaurant/menu-sections/${section.data.id}/items`,
      {
        token: ownerToken(restaurant),
        body: { name: 'Burger', basePrice: 12.5, position: 0 },
      },
    );
    expect(item.status).toBe(201);
    expect(item.data.basePrice).toBe('12.50');
    expect(item.data.sectionId).toBe(section.data.id);
  });

  it('refuses a duplicate menu name on the same branch with 409', async () => {
    await http.request('POST', `/restaurant/branches/${restaurant.branchId}/menus`, {
      token: ownerToken(restaurant),
      body: { name: 'Lunch' },
    });
    const dup = await http.request('POST', `/restaurant/branches/${restaurant.branchId}/menus`, {
      token: ownerToken(restaurant),
      body: { name: 'Lunch' },
    });
    expect(dup.status).toBe(409);
  });

  it('cross-tenant productId is refused 400 rather than silently accepted', async () => {
    const menu = await http.request<{ id: string }>(
      'POST',
      `/restaurant/branches/${restaurant.branchId}/menus`,
      { token: ownerToken(restaurant), body: { name: 'M' } },
    );
    const section = await http.request<{ id: string }>(
      'POST',
      `/restaurant/menus/${menu.data.id}/sections`,
      { token: ownerToken(restaurant), body: { name: 'S' } },
    );
    // Tile shop product id belongs to another tenant.
    const res = await http.request('POST', `/restaurant/menu-sections/${section.data.id}/items`, {
      token: ownerToken(restaurant),
      body: { name: 'Cross', basePrice: 1, productId: tile.productAId },
    });
    expect(res.status).toBe(400);
  });
});

describe('Restaurant Phase 2B — modifier groups', () => {
  it('creates a SINGLE group and refuses INVALID range', async () => {
    const good = await http.request('POST', '/restaurant/modifier-groups', {
      token: ownerToken(restaurant),
      body: {
        name: 'Bread',
        selection: 'SINGLE',
        options: [{ name: 'White' }, { name: 'Wheat', priceDelta: 0.5 }],
      },
    });
    expect(good.status).toBe(201);

    const bad = await http.request('POST', '/restaurant/modifier-groups', {
      token: ownerToken(restaurant),
      body: {
        name: 'BadRange',
        selection: 'SINGLE',
        minSelections: 2,
        maxSelections: 3,
        options: [{ name: 'A' }, { name: 'B' }],
      },
    });
    // SINGLE selection requires maxSelections=1.
    expect(bad.status).toBe(400);
  });
});
