/**
 * D66 — collections for every domain, and channel-scoped assortments
 * (convergence plan Phase 9).
 *
 * The phase's whole claim, held to D30 in both directions:
 *  - POSITIVE: a RETAIL tenant — refused this surface until now — authors a
 *    collection end to end (create → section → entry → filtered sellable),
 *    and a channel-scoped assortment serves exactly its channels.
 *  - NEGATIVE: a GENERAL tenant (collections capability deliberately false)
 *    is refused writes with the machine code while reads stay open; the
 *    LEGACY /restaurant/menus reads keep their MENU_MANAGEMENT gate — the
 *    SHARED_CORE reclassification opened the successor surface, not the
 *    frozen one.
 */
import {
  seedTenantRoles,
  syncPermissionCatalogue,
  linkUsersToRoles,
} from '@hardware-pos/database';
import type { PrismaClient } from '@hardware-pos/database';

import { connectTestPrisma, disconnectTestPrisma } from '../prisma-test-client';
import { resetDatabase } from '../db-reset';
import { seedTenant, seedTileShopWithQuickBooks, type SeededTenant } from '../fixtures';
import { createHttpIntegrationApp, type HttpIntegrationApp } from '../http-test-app';

let prisma: PrismaClient;
let http: HttpIntegrationApp;
let tile: SeededTenant;
let restaurant: SeededTenant;
let general: SeededTenant;

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
  restaurant = await seedTenant(prisma, {
    prefix: 'rest',
    name: 'Fixture Restaurant',
    slug: 'fixture-restaurant',
  });
  general = await seedTenant(prisma, {
    prefix: 'gen',
    name: 'Fixture General',
    slug: 'fixture-general',
  });
  await syncPermissionCatalogue(prisma);
  await seedTenantRoles(prisma, tile.tenantId, 'HARDWARE');
  await seedTenantRoles(prisma, restaurant.tenantId, 'RESTAURANT');
  await seedTenantRoles(prisma, general.tenantId, 'GENERAL');
  await linkUsersToRoles(prisma, tile.tenantId);
  await linkUsersToRoles(prisma, restaurant.tenantId);
  await linkUsersToRoles(prisma, general.tenantId);
  await prisma.tenantBusinessProfile.createMany({
    data: [
      {
        tenantId: restaurant.tenantId,
        businessType: 'RESTAURANT',
        inventoryMode: 'LOCAL',
        accountingProvider: 'NONE',
      },
      {
        tenantId: general.tenantId,
        businessType: 'GENERAL',
        inventoryMode: 'DISABLED',
        accountingProvider: 'NONE',
      },
    ],
  });
});

describe('D66 — retail authors collections', () => {
  it('a hardware tenant curates a collection end to end and the sellable listing serves it', async () => {
    const token = ownerToken(tile);
    const created = await http.request<{ id: string; channels: string[] }>(
      'POST',
      `/branches/${tile.branchId}/collections`,
      { token, body: { name: 'Trade counter', channels: ['COUNTER'] } },
    );
    expect(created.status).toBe(201);
    expect(created.data.channels).toEqual(['COUNTER']);

    const section = await http.request<{ id: string }>(
      'POST',
      `/collections/${created.data.id}/sections`,
      { token, body: { name: 'Fasteners' } },
    );
    expect(section.status).toBe(201);

    const entry = await http.request<{ id: string; productId: string }>(
      'POST',
      `/sections/${section.data.id}/entries`,
      { token, body: { productId: tile.productAId, priceOverride: 950 } },
    );
    expect(entry.status).toBe(201);

    // The POS read model serves the curated assortment, with the placement
    // price winning (COLLECTION_OVERRIDE — D62's price resolution).
    const page = await http.request<{
      items: { id: string; effectivePrice: string; priceSource: string }[];
    }>(
      'GET',
      `/products/sellable?branchId=${tile.branchId}&collectionId=${created.data.id}`,
      { token },
    );
    expect(page.status).toBe(200);
    expect(page.data.items.map((i) => i.id)).toEqual([tile.productAId]);
    expect(page.data.items[0].effectivePrice).toBe('950.00');
    expect(page.data.items[0].priceSource).toBe('COLLECTION_OVERRIDE');
  });
});

describe('D66 — channel-scoped assortments', () => {
  it('the list filter and the sellable read both honour the scope; unscoped means every channel', async () => {
    const token = ownerToken(restaurant);
    const dinner = await http.request<{ id: string }>(
      'POST',
      `/branches/${restaurant.branchId}/collections`,
      { token, body: { name: 'Dinner', channels: ['DINE_IN'] } },
    );
    const anytime = await http.request<{ id: string }>(
      'POST',
      `/branches/${restaurant.branchId}/collections`,
      { token, body: { name: 'Anytime' } },
    );
    expect(dinner.status).toBe(201);
    expect(anytime.status).toBe(201);

    const forDineIn = await http.request<{ id: string }[]>(
      'GET',
      `/branches/${restaurant.branchId}/collections?channel=DINE_IN`,
      { token },
    );
    expect(forDineIn.data.map((c) => c.id).sort()).toEqual(
      [dinner.data.id, anytime.data.id].sort(),
    );
    const forTakeaway = await http.request<{ id: string }[]>(
      'GET',
      `/branches/${restaurant.branchId}/collections?channel=TAKEAWAY`,
      { token },
    );
    expect(forTakeaway.data.map((c) => c.id)).toEqual([anytime.data.id]);

    // Sellable: the same scope decides whether the assortment serves at all.
    const section = await http.request<{ id: string }>(
      'POST',
      `/collections/${dinner.data.id}/sections`,
      { token, body: { name: 'Mains' } },
    );
    await http.request('POST', `/sections/${section.data.id}/entries`, {
      token,
      body: { productId: restaurant.productAId },
    });
    const dineIn = await http.request<{ items: unknown[] }>(
      'GET',
      `/products/sellable?branchId=${restaurant.branchId}&collectionId=${dinner.data.id}&channel=DINE_IN`,
      { token },
    );
    expect(dineIn.data.items).toHaveLength(1);
    const takeaway = await http.request<{ items: unknown[]; total: number }>(
      'GET',
      `/products/sellable?branchId=${restaurant.branchId}&collectionId=${dinner.data.id}&channel=TAKEAWAY`,
      { token },
    );
    expect(takeaway.data.items).toEqual([]);
    expect(takeaway.data.total).toBe(0);
  });
});

describe('D66 — the gates that stay shut', () => {
  it('a GENERAL tenant is refused writes with the machine code; reads stay open', async () => {
    const token = ownerToken(general);
    const refused = await http.request(
      'POST',
      `/branches/${general.branchId}/collections`,
      { token, body: { name: 'Nope' } },
    );
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ code: 'COLLECTIONS_NOT_ENABLED' });

    const read = await http.request<unknown[]>(
      'GET',
      `/branches/${general.branchId}/collections`,
      { token },
    );
    expect(read.status).toBe(200);
    expect(read.data).toEqual([]);
  });

  it('the LEGACY menu reads keep their MENU_MANAGEMENT gate — hardware is still 403 there', async () => {
    // The reclassification opened /branches/:id/collections, NOT the frozen
    // /restaurant surface. Both directions on the same tenant:
    const legacy = await http.request(
      'GET',
      `/restaurant/branches/${tile.branchId}/menus`,
      { token: ownerToken(tile) },
    );
    expect(legacy.status).toBe(403);
    const successor = await http.request(
      'GET',
      `/branches/${tile.branchId}/collections`,
      { token: ownerToken(tile) },
    );
    expect(successor.status).toBe(200);
  });
});
