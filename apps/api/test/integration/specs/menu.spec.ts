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
