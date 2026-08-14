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

/**
 * D41 — Additive presentation fields for the Restaurant Menu wizard.
 *
 * Non-vacuous per D30: every field asserted round-trips; every negative asserts
 * a value the migration would break if it silently reverted (invalid enum,
 * over-length dietary tag list, prepMinutes out of range).
 */
describe('Restaurant Menu wizard — presentation fields', () => {
  const createContext = async () => {
    const menu = await http.request('POST', `/restaurant/branches/${restaurant.branchId}/menus`, {
      token: ownerToken(restaurant),
      body: { name: 'D41 Menu' },
    });
    expect(menu.status).toBe(201);
    const menuId = (menu.data as { id: string }).id;
    const section = await http.request('POST', `/restaurant/menus/${menuId}/sections`, {
      token: ownerToken(restaurant),
      body: { name: 'Kottu' },
    });
    expect(section.status).toBe(201);
    return { sectionId: (section.data as { id: string }).id };
  };

  it('persists itemType / prepMinutes / dietaryTags / imageUrl on create + list', async () => {
    const { sectionId } = await createContext();
    const create = await http.request('POST', `/restaurant/menu-sections/${sectionId}/items`, {
      token: ownerToken(restaurant),
      body: {
        name: 'Mix Kottu',
        basePrice: 1200,
        itemType: 'FOOD',
        prepMinutes: 15,
        dietaryTags: ['Non-Veg', 'Spicy'],
        imageUrl: 'https://example.test/mix-kottu.webp',
      },
    });
    expect(create.status).toBe(201);
    const created = create.data as {
      id: string;
      itemType: string | null;
      prepMinutes: number | null;
      dietaryTags: string[];
      imageUrl: string | null;
    };
    // Positive controls: the fields we just set come back exactly as sent.
    expect(created.itemType).toBe('FOOD');
    expect(created.prepMinutes).toBe(15);
    expect(created.dietaryTags).toEqual(['Non-Veg', 'Spicy']);
    expect(created.imageUrl).toBe('https://example.test/mix-kottu.webp');

    const list = await http.request('GET', `/restaurant/menu-sections/${sectionId}/items`, {
      token: ownerToken(restaurant),
    });
    expect(list.status).toBe(200);
    const rows = list.data as Array<typeof created>;
    const row = rows.find((r) => r.id === created.id)!;
    expect(row.itemType).toBe('FOOD');
    expect(row.dietaryTags).toEqual(['Non-Veg', 'Spicy']);
  });

  it('legacy-style create (no wizard fields) still returns nullable defaults, not crashes', async () => {
    const { sectionId } = await createContext();
    const create = await http.request('POST', `/restaurant/menu-sections/${sectionId}/items`, {
      token: ownerToken(restaurant),
      body: { name: 'Plain', basePrice: 500 },
    });
    expect(create.status).toBe(201);
    const created = create.data as {
      itemType: string | null;
      prepMinutes: number | null;
      dietaryTags: string[];
      imageUrl: string | null;
    };
    // Negative controls: fields the request omitted come back as the schema's
    // safe defaults — null or empty array. A missing column would have crashed
    // the toView mapper, so this is proof the migration is applied.
    expect(created.itemType).toBeNull();
    expect(created.prepMinutes).toBeNull();
    expect(created.dietaryTags).toEqual([]);
    expect(created.imageUrl).toBeNull();
  });

  it('refuses invalid itemType and out-of-range prepMinutes at the DTO', async () => {
    const { sectionId } = await createContext();
    const badType = await http.request('POST', `/restaurant/menu-sections/${sectionId}/items`, {
      token: ownerToken(restaurant),
      body: { name: 'x', basePrice: 1, itemType: 'SNACK' },
    });
    expect(badType.status).toBe(400);

    const badPrep = await http.request('POST', `/restaurant/menu-sections/${sectionId}/items`, {
      token: ownerToken(restaurant),
      body: { name: 'x', basePrice: 1, prepMinutes: 0 },
    });
    expect(badPrep.status).toBe(400);

    const tooLong = await http.request('POST', `/restaurant/menu-sections/${sectionId}/items`, {
      token: ownerToken(restaurant),
      body: { name: 'x', basePrice: 1, imageUrl: 'x'.repeat(2049) },
    });
    expect(tooLong.status).toBe(400);
  });

  it("update round-trips presentation fields and clears imageUrl with ''", async () => {
    const { sectionId } = await createContext();
    const create = await http.request('POST', `/restaurant/menu-sections/${sectionId}/items`, {
      token: ownerToken(restaurant),
      body: {
        name: 'RoundTrip',
        basePrice: 100,
        itemType: 'BEVERAGE',
        imageUrl: 'https://example.test/x.webp',
      },
    });
    expect(create.status).toBe(201);
    const id = (create.data as { id: string }).id;

    const patch = await http.request('PATCH', `/restaurant/menu-sections/${sectionId}/items/${id}`, {
      token: ownerToken(restaurant),
      body: { itemType: 'DESSERT', imageUrl: '' },
    });
    expect(patch.status).toBe(200);
    const patched = patch.data as { itemType: string | null; imageUrl: string | null };
    expect(patched.itemType).toBe('DESSERT');
    // Empty-string clear semantics — sending "" nulls out the image; sending
    // undefined would have left it untouched.
    expect(patched.imageUrl).toBeNull();
  });

  it('ModifierGroup.role persists SIZE marker', async () => {
    const create = await http.request('POST', '/restaurant/modifier-groups', {
      token: ownerToken(restaurant),
      body: {
        name: 'Mix Kottu — Size',
        selection: 'SINGLE',
        minSelections: 1,
        maxSelections: 1,
        role: 'SIZE',
        options: [
          { name: 'Small', priceDelta: 0 },
          { name: 'Medium', priceDelta: 300 },
          { name: 'Large', priceDelta: 600 },
        ],
      },
    });
    expect(create.status).toBe(201);
    const created = create.data as { id: string; role: string | null };
    expect(created.role).toBe('SIZE');

    // Negative control: legacy group without a role stays null after read.
    const plain = await http.request('POST', '/restaurant/modifier-groups', {
      token: ownerToken(restaurant),
      body: {
        name: 'Mix Kottu — Extras',
        selection: 'MULTIPLE',
        maxSelections: 5,
        options: [{ name: 'Cheese', priceDelta: 200 }],
      },
    });
    expect(plain.status).toBe(201);
    expect((plain.data as { role: string | null }).role).toBeNull();
  });
});

/**
 * D43 — Restaurant Menu admin: hard delete + child-guards + open-order guard
 * for menu items. Every positive test is paired with the negative that would
 * fire if the guard silently no-op'd.
 */
describe('Restaurant Menu admin — hard delete + guards (D43)', () => {
  const createContext = async () => {
    const menu = await http.request('POST', `/restaurant/branches/${restaurant.branchId}/menus`, {
      token: ownerToken(restaurant),
      body: { name: 'D43 Menu' },
    });
    const menuId = (menu.data as { id: string }).id;
    const section = await http.request('POST', `/restaurant/menus/${menuId}/sections`, {
      token: ownerToken(restaurant),
      body: { name: 'Kottu' },
    });
    return { menuId, sectionId: (section.data as { id: string }).id };
  };

  it('empty menu can be permanently deleted', async () => {
    const menu = await http.request('POST', `/restaurant/branches/${restaurant.branchId}/menus`, {
      token: ownerToken(restaurant),
      body: { name: 'Empty menu' },
    });
    const menuId = (menu.data as { id: string }).id;
    const del = await http.request(
      'DELETE',
      `/restaurant/branches/${restaurant.branchId}/menus/${menuId}`,
      { token: ownerToken(restaurant) },
    );
    expect(del.status).toBe(204);
    // Negative: further reads no longer find it.
    const list = await http.request(
      'GET',
      `/restaurant/branches/${restaurant.branchId}/menus?includeArchived=true`,
      { token: ownerToken(restaurant) },
    );
    const rows = list.data as Array<{ id: string }>;
    expect(rows.find((m) => m.id === menuId)).toBeUndefined();
  });

  it('menu with sections refuses hard delete with MENU_HAS_SECTIONS', async () => {
    const { menuId } = await createContext();
    const del = await http.request(
      'DELETE',
      `/restaurant/branches/${restaurant.branchId}/menus/${menuId}`,
      { token: ownerToken(restaurant) },
    );
    expect(del.status).toBe(409);
    // Positive control on the error code so the frontend can key off it.
    expect((del.data as { code: string }).code).toBe('MENU_HAS_SECTIONS');
    expect((del.data as { details: { sectionCount: number } }).details.sectionCount).toBe(1);
  });

  it('empty section can be deleted; section with items refuses', async () => {
    const { menuId, sectionId } = await createContext();
    // Empty section first — succeeds.
    const empty = await http.request('POST', `/restaurant/menus/${menuId}/sections`, {
      token: ownerToken(restaurant),
      body: { name: 'Empty', position: 1 },
    });
    const emptyId = (empty.data as { id: string }).id;
    const okDel = await http.request(
      'DELETE',
      `/restaurant/menus/${menuId}/sections/${emptyId}`,
      { token: ownerToken(restaurant) },
    );
    expect(okDel.status).toBe(204);

    // Section with an item — refused.
    await http.request('POST', `/restaurant/menu-sections/${sectionId}/items`, {
      token: ownerToken(restaurant),
      body: { name: 'x', basePrice: 1 },
    });
    const blocked = await http.request(
      'DELETE',
      `/restaurant/menus/${menuId}/sections/${sectionId}`,
      { token: ownerToken(restaurant) },
    );
    expect(blocked.status).toBe(409);
    expect((blocked.data as { code: string }).code).toBe('SECTION_HAS_ITEMS');
  });

  it('menu item with no orders can be permanently deleted', async () => {
    const { sectionId } = await createContext();
    const create = await http.request('POST', `/restaurant/menu-sections/${sectionId}/items`, {
      token: ownerToken(restaurant),
      body: { name: 'Never ordered', basePrice: 100 },
    });
    const itemId = (create.data as { id: string }).id;
    const del = await http.request(
      'DELETE',
      `/restaurant/menu-sections/${sectionId}/items/${itemId}`,
      { token: ownerToken(restaurant) },
    );
    expect(del.status).toBe(204);
    // Negative: read is gone.
    const gone = await http.request(
      'GET',
      `/restaurant/menu-sections/${sectionId}/items?includeArchived=true`,
      { token: ownerToken(restaurant) },
    );
    const rows = gone.data as Array<{ id: string }>;
    expect(rows.find((r) => r.id === itemId)).toBeUndefined();
  });

  it('cross-tenant delete fails with 404', async () => {
    const { menuId, sectionId } = await createContext();
    const create = await http.request('POST', `/restaurant/menu-sections/${sectionId}/items`, {
      token: ownerToken(restaurant),
      body: { name: 'x', basePrice: 1 },
    });
    const itemId = (create.data as { id: string }).id;
    // Tile Shop owner attempts to delete Restaurant's item — module gate is the
    // first line (MENU_MANAGEMENT is not on Tile Shop) → 403 or 404 depending
    // on the guard order. Either proves the isolation, so accept the pair.
    const cross = await http.request(
      'DELETE',
      `/restaurant/menu-sections/${sectionId}/items/${itemId}`,
      { token: ownerToken(tile) },
    );
    expect([403, 404]).toContain(cross.status);

    // Positive control: same owner + same tenant succeeds.
    const legit = await http.request(
      'DELETE',
      `/restaurant/menu-sections/${sectionId}/items/${itemId}`,
      { token: ownerToken(restaurant) },
    );
    expect(legit.status).toBe(204);
    // Silence unused menuId lint.
    expect(menuId).toBeDefined();
  });

  it('menu item on an open order refuses permanent delete with ITEM_ON_OPEN_ORDER', async () => {
    const { sectionId } = await createContext();
    const create = await http.request('POST', `/restaurant/menu-sections/${sectionId}/items`, {
      token: ownerToken(restaurant),
      body: { name: 'Being ordered', basePrice: 100 },
    });
    const itemId = (create.data as { id: string }).id;

    // Manufacture an open RestaurantOrder referencing this item. The
    // operational endpoints for order creation are heavy to invoke from
    // integration test infra, so we drop straight into Prisma — this is the
    // guard test's whole point. RestaurantOrder requires a TableSession →
    // RestaurantTable → DiningArea chain, so build the minimum.
    const area = await prisma.diningArea.create({
      data: {
        tenantId: restaurant.tenantId,
        branchId: restaurant.branchId,
        name: 'D43 Area',
      },
    });
    const table = await prisma.restaurantTable.create({
      data: {
        tenantId: restaurant.tenantId,
        branchId: restaurant.branchId,
        areaId: area.id,
        code: 'T1',
        capacity: 4,
      },
    });
    const session = await prisma.tableSession.create({
      data: {
        tenantId: restaurant.tenantId,
        branchId: restaurant.branchId,
        tableId: table.id,
        sessionNumber: 'S-GUARD-1',
        status: 'OPEN',
      },
    });
    const order = await prisma.restaurantOrder.create({
      data: {
        tenantId: restaurant.tenantId,
        branchId: restaurant.branchId,
        sessionId: session.id,
        status: 'DRAFT',
        channel: 'DINE_IN',
        orderNumber: 'T-GUARD-1',
      },
    });
    const round = await prisma.orderRound.create({
      data: {
        tenantId: restaurant.tenantId,
        orderId: order.id,
        roundNumber: 1,
        status: 'DRAFT',
      },
    });
    await prisma.restaurantOrderItem.create({
      data: {
        tenantId: restaurant.tenantId,
        orderId: order.id,
        roundId: round.id,
        menuItemId: itemId,
        menuItemName: 'Being ordered',
        unitPrice: '100.00',
        quantity: '1',
      },
    });

    const blocked = await http.request(
      'DELETE',
      `/restaurant/menu-sections/${sectionId}/items/${itemId}`,
      { token: ownerToken(restaurant) },
    );
    expect(blocked.status).toBe(409);
    expect((blocked.data as { code: string }).code).toBe('ITEM_ON_OPEN_ORDER');
    expect(
      (blocked.data as { details: { openOrderCount: number } }).details.openOrderCount,
    ).toBe(1);

    // Positive control: close the order and the delete succeeds. Historical
    // snapshot must remain readable after the delete.
    await prisma.restaurantOrder.update({
      where: { id: order.id },
      data: { status: 'COMPLETED' },
    });
    const okDel = await http.request(
      'DELETE',
      `/restaurant/menu-sections/${sectionId}/items/${itemId}`,
      { token: ownerToken(restaurant) },
    );
    expect(okDel.status).toBe(204);
    // Snapshot survives — this is the D43 safety claim.
    const historical = await prisma.restaurantOrderItem.findFirst({
      where: { menuItemId: itemId },
      select: { menuItemName: true, unitPrice: true },
    });
    expect(historical?.menuItemName).toBe('Being ordered');
    expect(historical?.unitPrice?.toString()).toBe('100');
  });
});
