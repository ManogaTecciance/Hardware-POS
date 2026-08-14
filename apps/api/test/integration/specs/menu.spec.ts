/**
 * The frozen menu surface (D60 — was: Restaurant Phase 2B menu lifecycle).
 *
 * This spec used to exercise the menu/section/item WRITE lifecycle. D60 froze
 * that surface: the Product wizard has been the single authoring surface
 * since D45, the convergence backfill migrated every placement into
 * `CatalogueEntry`, and every legacy write route now answers `410 Gone`
 * naming the successor. The write-path properties the old spec pinned
 * (duplicate-name refusal, cross-tenant reference 404s) died WITH the write
 * path — asserting them would require the writes to work.
 *
 * What must still hold, per D30 in both directions:
 *  - POSITIVE: reads serve the retained rows — historical orders, KOT
 *    reprints and the support-only legacy browser depend on that.
 *  - NEGATIVE: every write verb on every menu resource is 410 — with the
 *    machine-readable code, so a client distinguishes "gone" from "forbidden".
 *  - The module gate still guards the reads (a hardware tenant gets 403,
 *    which also proves the 410s above are the freeze, not a guard accident).
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

/** A legacy menu tree, created at the DATABASE level — rows are retained
 *  and readable; only the HTTP write surface is frozen. */
async function seedLegacyMenuTree() {
  const menu = await prisma.menu.create({
    data: { tenantId: restaurant.tenantId, branchId: restaurant.branchId, name: 'Frozen Menu' },
  });
  const section = await prisma.menuSection.create({
    data: { tenantId: restaurant.tenantId, menuId: menu.id, name: 'Frozen Mains' },
  });
  const item = await prisma.menuItem.create({
    data: {
      tenantId: restaurant.tenantId,
      sectionId: section.id,
      name: 'Frozen Burger',
      basePrice: '12.50',
    },
  });
  return { menu, section, item };
}

beforeEach(async () => {
  await resetDatabase(prisma);
  tile = await seedTileShopWithQuickBooks(prisma);
  restaurant = await seedSecondTenant(prisma);
  await syncPermissionCatalogue(prisma);
  await seedTenantRoles(prisma, tile.tenantId, 'HARDWARE');
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

describe('D60 — reads still serve the retained rows', () => {
  it('a restaurant tenant lists menus, sections and items', async () => {
    const { menu, section, item } = await seedLegacyMenuTree();

    const menus = await http.request<{ id: string; name: string }[]>(
      'GET',
      `/restaurant/branches/${restaurant.branchId}/menus`,
      { token: ownerToken(restaurant) },
    );
    expect(menus.status).toBe(200);
    expect(menus.data.map((m) => m.id)).toContain(menu.id);

    const sections = await http.request<{ id: string }[]>(
      'GET',
      `/restaurant/menus/${menu.id}/sections`,
      { token: ownerToken(restaurant) },
    );
    expect(sections.status).toBe(200);
    expect(sections.data.map((s) => s.id)).toContain(section.id);

    const items = await http.request<{ id: string; basePrice: string }[]>(
      'GET',
      `/restaurant/menu-sections/${section.id}/items`,
      { token: ownerToken(restaurant) },
    );
    expect(items.status).toBe(200);
    const served = items.data.find((i) => i.id === item.id);
    expect(served?.basePrice).toBe('12.50');
  });

  it('the module gate still guards the reads — a hardware tenant is refused 403', async () => {
    const res = await http.request('GET', `/restaurant/branches/${tile.branchId}/menus`, {
      token: ownerToken(tile),
    });
    expect(res.status).toBe(403);
  });
});

describe('D60 — every write verb on the menu surface is 410 Gone', () => {
  it.each([
    ['POST menus', () => ['POST', `/restaurant/branches/${restaurant.branchId}/menus`, { name: 'X' }] as const],
    ['PATCH menu', () => ['PATCH', `/restaurant/branches/${restaurant.branchId}/menus/some-id`, { name: 'Y' }] as const],
    ['DELETE menu', () => ['DELETE', `/restaurant/branches/${restaurant.branchId}/menus/some-id`, undefined] as const],
    ['POST sections', () => ['POST', `/restaurant/menus/some-id/sections`, { name: 'X' }] as const],
    ['PATCH section', () => ['PATCH', `/restaurant/menus/some-id/sections/other`, { name: 'Y' }] as const],
    ['DELETE section', () => ['DELETE', `/restaurant/menus/some-id/sections/other`, undefined] as const],
    ['POST items', () => ['POST', `/restaurant/menu-sections/some-id/items`, { name: 'X', basePrice: 1 }] as const],
    ['PATCH item', () => ['PATCH', `/restaurant/menu-sections/some-id/items/other`, { name: 'Y' }] as const],
    ['DELETE item', () => ['DELETE', `/restaurant/menu-sections/some-id/items/other`, undefined] as const],
  ])('%s → 410 MENU_WRITES_GONE', async (_label, build) => {
    const [method, path, body] = build();
    const res = await http.request<{ code?: string; message?: string }>(method, path, {
      token: ownerToken(restaurant),
      ...(body ? { body } : {}),
    });
    expect(res.status).toBe(410);
    // Machine-readable, and the message names the successor — a client can
    // tell "moved to Products" from "you may not".
    expect(res.data.code).toBe('MENU_WRITES_GONE');
    expect(res.data.message).toContain('Products');
  });

  it('the freeze does not bleed into the still-writable modifier groups', async () => {
    // POSITIVE CONTROL: modifier groups are shared catalogue (they move under
    // /products in Phase 5, they are NOT frozen). If this failed 410 the
    // freeze guard would be over-applied.
    const res = await http.request<{ id: string }>('POST', '/restaurant/modifier-groups', {
      token: ownerToken(restaurant),
      body: {
        name: 'Still Writable',
        selection: 'SINGLE',
        options: [{ name: 'Yes', priceDelta: 0 }],
      },
    });
    expect(res.status).toBe(201);
  });

  it('the frozen rows are untouched by a refused write', async () => {
    const { item } = await seedLegacyMenuTree();
    await http.request('PATCH', `/restaurant/menu-sections/${item.sectionId}/items/${item.id}`, {
      token: ownerToken(restaurant),
      body: { name: 'Should Not Apply' },
    });
    const row = await prisma.menuItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(row.name).toBe('Frozen Burger');
  });
});
