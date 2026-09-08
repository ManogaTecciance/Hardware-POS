/**
 * D65 — components and submit-time round depletion, end to end (convergence
 * plan §8.8, Phase 8; Q4 resolved: submit, compensating movement on void).
 *
 * D30 in both directions throughout:
 *  - POSITIVE: recipes round-trip; a STOCK_ITEM line and a composed line
 *    with a recipe move real stock and write ORDER_ROUND ledger rows that
 *    name the order item; a void restores exactly what was recorded.
 *  - NEGATIVE: a componentless composed dish moves NOTHING (that inertness
 *    IS the D65 decision); the dish product itself never moves when its
 *    components do; a refused (oversold) round leaves no rows at all; the
 *    capability gate refuses recipe writes for a non-declaring tenant while
 *    the SAME request shape succeeds for the declaring one.
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
let branchId: string;
let orderId: string;
let beerId: string; // STOCK_ITEM, qty 10
let dishId: string; // COMPOSED_ITEM with a recipe
let bareDishId: string; // COMPOSED_ITEM without one
let bunId: string; // ingredient, qty 20
let pattyId: string; // ingredient, qty 5

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
  branchId = restaurant.branchId;
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

  const product = (data: Record<string, unknown>) =>
    prisma.product.create({
      data: {
        tenantId: restaurant.tenantId,
        type: 'Inventory',
        isActive: true,
        ...data,
      } as never,
    });
  beerId = (
    await product({ name: 'Bottled Beer', sku: 'R-BEER', unitPrice: '4.00', quantityOnHand: '10' })
  ).id;
  bunId = (
    await product({ name: 'Bun', sku: 'R-BUN', unitPrice: '0.50', quantityOnHand: '20' })
  ).id;
  pattyId = (
    await product({ name: 'Patty', sku: 'R-PATTY', unitPrice: '1.00', quantityOnHand: '5' })
  ).id;
  dishId = (
    await product({
      name: 'Burger',
      sku: 'R-BURGER',
      unitPrice: '12.00',
      quantityOnHand: '0',
      sellableKind: 'COMPOSED_ITEM',
    })
  ).id;
  bareDishId = (
    await product({
      name: 'Kottu',
      sku: 'R-KOTTU',
      unitPrice: '9.00',
      quantityOnHand: '0',
      sellableKind: 'COMPOSED_ITEM',
    })
  ).id;

  // Dining fixture: area → table → session → order.
  const area = await prisma.diningArea.create({
    data: { tenantId: restaurant.tenantId, branchId, name: 'Main' },
  });
  const table = await prisma.restaurantTable.create({
    data: { tenantId: restaurant.tenantId, branchId, areaId: area.id, code: 'T1', capacity: 4 },
  });
  const sessionRes = await http.request<{ id: string }>(
    'POST',
    `/restaurant/branches/${branchId}/table-sessions`,
    { token: ownerToken(restaurant), body: { tableId: table.id } },
  );
  const orderRes = await http.request<{ id: string }>(
    'POST',
    `/restaurant/table-sessions/${sessionRes.data.id}/orders`,
    { token: ownerToken(restaurant) },
  );
  orderId = orderRes.data.id;
});

const putComponents = (productId: string, components: unknown[], tenant = restaurant) =>
  http.request<{ components: { componentProductId: string; quantity: string }[] }>(
    'PUT',
    `/products/${productId}/components`,
    { token: ownerToken(tenant), body: { components } },
  );

const submitRound = (key: string, items: unknown[]) =>
  http.request<{ id: string; itemIds: string[] }>(
    'POST',
    `/restaurant/orders/${orderId}/rounds`,
    { token: ownerToken(restaurant), body: { idempotencyKey: key, items } },
  );

const qty = async (productId: string) =>
  (
    await prisma.product.findUniqueOrThrow({
      where: { id: productId },
      select: { quantityOnHand: true },
    })
  ).quantityOnHand.toNumber();

const burgerRecipe = () =>
  putComponents(dishId, [
    { componentProductId: bunId, quantity: 1 },
    // 0.15 kg at 5% wastage → 0.1575 per dish.
    { componentProductId: pattyId, quantity: 0.15, wastageRate: 0.05 },
  ]);

describe('D65 — recipe authoring', () => {
  it('a declaring tenant round-trips a recipe; the same shape is refused without the capability', async () => {
    const ok = await burgerRecipe();
    expect(ok.status).toBe(200);
    expect(ok.data.components.map((c) => c.componentProductId).sort()).toEqual(
      [bunId, pattyId].sort(),
    );

    const read = await http.request<{ components: unknown[] }>(
      'GET',
      `/products/${dishId}/components`,
      { token: ownerToken(restaurant) },
    );
    expect(read.status).toBe(200);
    expect(read.data.components).toHaveLength(2);

    // NEGATIVE — hardware does not declare `catalogue.components`; the
    // refusal is the capability, not a broken route (the GET still serves).
    const refused = await putComponents(
      tile.productAId,
      [{ componentProductId: tile.productBId, quantity: 1 }],
      tile,
    );
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ code: 'COMPONENTS_NOT_ENABLED' });
    const tileRead = await http.request<{ components: unknown[] }>(
      'GET',
      `/products/${tile.productAId}/components`,
      { token: ownerToken(tile) },
    );
    expect(tileRead.status).toBe(200);
    expect(tileRead.data.components).toEqual([]);
  });

  it('refuses self-reference, non-positive quantity and a cross-tenant component', async () => {
    expect((await putComponents(dishId, [{ componentProductId: dishId, quantity: 1 }])).status).toBe(
      400,
    );
    expect((await putComponents(dishId, [{ componentProductId: bunId, quantity: 0 }])).status).toBe(
      400,
    );
    expect(
      (await putComponents(dishId, [{ componentProductId: tile.productAId, quantity: 1 }])).status,
    ).toBe(404);
    // Positive control: the valid shape still lands after the refusals.
    expect((await burgerRecipe()).status).toBe(200);
  });
});

describe('D65 — submit-time depletion', () => {
  it('a STOCK_ITEM line depletes itself 1:1 and writes the ORDER_ROUND movement', async () => {
    const res = await submitRound('beer-round', [
      { sourceKind: 'PRODUCT', productId: beerId, quantity: 2 },
    ]);
    expect(res.status).toBe(201);
    expect(await qty(beerId)).toBe(8);

    const item = await prisma.restaurantOrderItem.findFirstOrThrow({
      where: { roundId: res.data.id },
    });
    const movements = await prisma.stockMovement.findMany({
      where: { tenantId: restaurant.tenantId, reason: 'ORDER_ROUND' },
    });
    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({
      productId: beerId,
      refType: 'RESTAURANT_ORDER_ITEM',
      refId: item.id,
      branchId,
    });
    expect(movements[0].delta.toNumber()).toBe(-2);
    expect(movements[0].balanceAfter.toNumber()).toBe(8);
  });

  it('a composed line depletes its COMPONENTS (with wastage), never the dish itself', async () => {
    await burgerRecipe();
    const res = await submitRound('burger-round', [
      { sourceKind: 'PRODUCT', productId: dishId, quantity: 2 },
    ]);
    expect(res.status).toBe(201);

    expect(await qty(bunId)).toBe(18); // 20 − 2×1
    expect(await qty(pattyId)).toBeCloseTo(4.685, 3); // 5 − 2×0.15×1.05
    expect(await qty(dishId)).toBe(0); // the dish row never moves

    const movements = await prisma.stockMovement.findMany({
      where: { tenantId: restaurant.tenantId, reason: 'ORDER_ROUND' },
    });
    expect(movements.map((m) => m.productId).sort()).toEqual([bunId, pattyId].sort());
    expect(movements.map((m) => m.productId)).not.toContain(dishId);
  });

  it('a componentless composed dish moves NOTHING — and the round still succeeds', async () => {
    const res = await submitRound('kottu-round', [
      { sourceKind: 'PRODUCT', productId: bareDishId, quantity: 3 },
    ]);
    expect(res.status).toBe(201);
    expect(await qty(bareDishId)).toBe(0);
    expect(
      await prisma.stockMovement.count({
        where: { tenantId: restaurant.tenantId, reason: 'ORDER_ROUND' },
      }),
    ).toBe(0);
  });

  it('an oversold tracked line refuses the WHOLE round: no items, no movements, no stock change', async () => {
    const res = await submitRound('too-much-beer', [
      { sourceKind: 'PRODUCT', productId: beerId, quantity: 99 },
    ]);
    expect(res.status).toBe(400);
    expect(await qty(beerId)).toBe(10);
    expect(
      await prisma.restaurantOrderItem.count({ where: { tenantId: restaurant.tenantId } }),
    ).toBe(0);
    expect(
      await prisma.stockMovement.count({
        where: { tenantId: restaurant.tenantId, reason: 'ORDER_ROUND' },
      }),
    ).toBe(0);
    // Positive control on the same shape at a possible quantity.
    expect(
      (await submitRound('possible-beer', [{ sourceKind: 'PRODUCT', productId: beerId, quantity: 1 }]))
        .status,
    ).toBe(201);
  });

  it('voiding a depleted item restores the RECORDED movements, once', async () => {
    const res = await submitRound('void-me', [
      { sourceKind: 'PRODUCT', productId: beerId, quantity: 2 },
    ]);
    const itemId = res.data.itemIds[0];
    expect(await qty(beerId)).toBe(8);

    const voidRes = await http.request('POST', `/restaurant/order-items/${itemId}/void`, {
      token: ownerToken(restaurant),
      body: { reason: 'customer changed mind' },
    });
    expect(voidRes.status).toBe(204);
    expect(await qty(beerId)).toBe(10);

    const compensations = await prisma.stockMovement.findMany({
      where: { tenantId: restaurant.tenantId, refType: 'RESTAURANT_ORDER_ITEM_VOID' },
    });
    expect(compensations).toHaveLength(1);
    expect(compensations[0]).toMatchObject({ productId: beerId, refId: itemId });
    expect(compensations[0].delta.toNumber()).toBe(2);
    expect(compensations[0].balanceAfter.toNumber()).toBe(10);

    // Idempotent: a second void restores nothing again.
    await http.request('POST', `/restaurant/order-items/${itemId}/void`, {
      token: ownerToken(restaurant),
      body: { reason: 'double tap' },
    });
    expect(await qty(beerId)).toBe(10);
    expect(
      await prisma.stockMovement.count({
        where: { tenantId: restaurant.tenantId, refType: 'RESTAURANT_ORDER_ITEM_VOID' },
      }),
    ).toBe(1);
  });

  it('takeaway accepts PRODUCT-sourced items — the counter POS path (2026-08-18)', async () => {
    /*
     * The counter POS routes every mode (its "dine-in" included) through
     * POST /restaurant/takeaway with PRODUCT-sourced lines. This used to be
     * refused with "Takeaway does not yet accept Product-sourced items" at
     * the payment step; intake now rides the same resolver as a dine-in
     * round, modifiers included.
     */
    const group = await prisma.modifierGroup.create({
      data: {
        tenantId: restaurant.tenantId,
        name: 'Serving',
        selection: 'SINGLE',
        minSelections: 0,
        maxSelections: 1,
        options: { create: [{ tenantId: restaurant.tenantId, name: 'Chilled', priceDelta: '0.50' }] },
      },
      include: { options: true },
    });
    await prisma.productModifierGroup.create({
      data: { productId: beerId, modifierGroupId: group.id },
    });

    const res = await http.request<{ orderId: string }>('POST', '/restaurant/takeaway', {
      token: ownerToken(restaurant),
      body: {
        branchId,
        idempotencyKey: 'takeaway-product-1',
        items: [
          {
            sourceKind: 'PRODUCT',
            productId: beerId,
            quantity: 2,
            modifiers: [{ modifierOptionId: group.options[0].id }],
          },
        ],
      },
    });
    expect(res.status).toBe(201);

    // The row snapshots exactly as a dine-in round would: PRODUCT source,
    // price from the product, the modifier frozen with its delta.
    const item = await prisma.restaurantOrderItem.findFirstOrThrow({
      where: { tenantId: restaurant.tenantId, productId: beerId, sourceKind: 'PRODUCT' },
      include: { modifiers: true },
    });
    expect(item.unitPrice.toFixed(2)).toBe('4.00');
    expect(item.modifierTotal.toFixed(2)).toBe('0.50');
    expect(item.modifiers).toHaveLength(1);
    expect(item.modifiers[0]).toMatchObject({ optionName: 'Chilled', groupName: 'Serving' });

    // And it depletes (D65), exactly like dine-in.
    expect(await qty(beerId)).toBe(8);

    // NEGATIVE — the shared guard applies here too: a modifier option not
    // attached to the ordered product refuses the whole create.
    const orphanGroup = await prisma.modifierGroup.create({
      data: {
        tenantId: restaurant.tenantId,
        name: 'Unattached',
        selection: 'SINGLE',
        minSelections: 0,
        maxSelections: 1,
        options: { create: [{ tenantId: restaurant.tenantId, name: 'Nope', priceDelta: '1.00' }] },
      },
      include: { options: true },
    });
    const refused = await http.request('POST', '/restaurant/takeaway', {
      token: ownerToken(restaurant),
      body: {
        branchId,
        idempotencyKey: 'takeaway-product-2',
        items: [
          {
            sourceKind: 'PRODUCT',
            productId: beerId,
            quantity: 1,
            modifiers: [{ modifierOptionId: orphanGroup.options[0].id }],
          },
        ],
      },
    });
    expect(refused.status).toBe(400);
  });

  it('the takeaway path depletes through the linked product exactly like dine-in', async () => {
    const menu = await prisma.menu.create({
      data: { tenantId: restaurant.tenantId, branchId, name: 'Takeaway Menu' },
    });
    const section = await prisma.menuSection.create({
      data: { tenantId: restaurant.tenantId, menuId: menu.id, name: 'Drinks' },
    });
    const menuItem = await prisma.menuItem.create({
      data: {
        tenantId: restaurant.tenantId,
        sectionId: section.id,
        name: 'Bottled Beer',
        basePrice: '4.00',
        productId: beerId,
      },
    });

    const res = await http.request<{ orderId: string }>('POST', '/restaurant/takeaway', {
      token: ownerToken(restaurant),
      body: {
        branchId,
        idempotencyKey: 'takeaway-beer',
        items: [{ menuItemId: menuItem.id, quantity: 3 }],
      },
    });
    expect(res.status).toBe(201);
    expect(await qty(beerId)).toBe(7);
    const movement = await prisma.stockMovement.findFirstOrThrow({
      where: { tenantId: restaurant.tenantId, reason: 'ORDER_ROUND' },
    });
    expect(movement.delta.toNumber()).toBe(-3);
  });
});

describe('D65 — sellableKind derivation at authoring time', () => {
  it('classifies exactly as the D60 backfill did: Service → SERVICE, foodType → COMPOSED_ITEM, else STOCK_ITEM', async () => {
    const create = (body: Record<string, unknown>) =>
      http.request<{ id: string; sellableKind: string }>('POST', '/products', {
        token: ownerToken(restaurant),
        body: { unitPrice: 5, ...body },
      });

    const dish = await create({ name: 'New Dish', sku: 'D-NEW', foodType: 'FOOD' });
    expect(dish.status).toBe(201);
    expect(dish.data.sellableKind).toBe('COMPOSED_ITEM');

    const service = await create({ name: 'Corkage', sku: 'D-CORK', type: 'Service' });
    expect(service.data.sellableKind).toBe('SERVICE');

    const plain = await create({ name: 'Packaged Snack', sku: 'D-SNACK' });
    expect(plain.data.sellableKind).toBe('STOCK_ITEM');

    // Update re-derives only when an input of the rule changes: clearing the
    // foodType reclassifies; renaming does not touch the classification.
    const cleared = await http.request<{ sellableKind: string }>(
      'PATCH',
      `/products/${dish.data.id}`,
      { token: ownerToken(restaurant), body: { foodType: null } },
    );
    expect(cleared.data.sellableKind).toBe('STOCK_ITEM');
    const renamed = await http.request<{ sellableKind: string }>(
      'PATCH',
      `/products/${service.data.id}`,
      { token: ownerToken(restaurant), body: { name: 'Corkage fee' } },
    );
    expect(renamed.data.sellableKind).toBe('SERVICE');
  });
});
