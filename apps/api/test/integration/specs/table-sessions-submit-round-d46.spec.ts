/**
 * D46 — `submitRound` widening.
 *
 * Phase 1 landed the schema. This spec covers the service behaviour behind
 * the D46 wire: a round can now carry MENU_ITEM-sourced items (legacy
 * default) AND PRODUCT-sourced items with an optional ProductVariant
 * selection. The service resolves each source to a uniform snapshot, and
 * `KitchenService.generateTicketsForRound` reads the appropriate
 * station-link junction.
 *
 * D30 compliance — every rejection test has a paired positive control (the
 * same shape but with the required field valid), so a mutation that turned
 * "throw" into "return" would flip both cases:
 *
 *   • T3 mutation-proves the variant snapshot: BOTH `variantPriceSnapshot`
 *     AND the item's `unitPrice` must equal the variant's price (not the
 *     Product's base price, and not a base+delta). A bug in the picker that
 *     silently used the base price would keep T2 green but fail T3.
 *   • The rejection tests each also assert that NO RestaurantOrderItem row
 *     was written — a validation that runs after the write would satisfy
 *     the "throws" assertion but leak state; the row-count guard catches it.
 *   • K1/K2/K3 are mirrored between the round-item table and the
 *     KitchenTicketItem table, so a lookup regression on the widened
 *     junction reads (Product vs MenuItem) surfaces on both sides.
 */
import {
  seedTenantRoles,
  syncPermissionCatalogue,
  linkUsersToRoles,
} from '@hardware-pos/database';
import type { PrismaClient } from '@hardware-pos/database';

import { connectTestPrisma, disconnectTestPrisma } from '../prisma-test-client';
import { resetDatabase } from '../db-reset';
import { seedSecondTenant, seedTenant, type SeededTenant } from '../fixtures';
import { createHttpIntegrationApp, type HttpIntegrationApp } from '../http-test-app';

let prisma: PrismaClient;
let http: HttpIntegrationApp;
let restaurant: SeededTenant;
let otherRestaurant: SeededTenant;
let branchId: string;
let tableId: string;
let sessionId: string;
let orderId: string;
// Products in `restaurant`.
let simpleProductId: string;
let variantProductId: string;
let variantSmallId: string;
let variantMediumId: string;
let variantLargeInactiveId: string;
let inactiveProductId: string;
// A second product's variant — used to prove variant-not-on-product refuses.
let otherProductVariantId: string;
// Kitchen stations.
let grillStationId: string;
let barStationId: string;
// Modifier group attached to variantProduct only, and one option each.
let attachedGroupId: string;
let attachedOptionId: string;
let unattachedOptionId: string;
// Cross-tenant Product + variant on `otherRestaurant`.
let crossTenantProductId: string;
let crossTenantVariantId: string;

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
  restaurant = await seedSecondTenant(prisma);
  otherRestaurant = await seedTenant(prisma, {
    prefix: 'rest2',
    name: 'Fixture Restaurant Two',
    slug: 'fixture-restaurant-two',
  });
  branchId = restaurant.branchId;

  await syncPermissionCatalogue(prisma);
  await seedTenantRoles(prisma, restaurant.tenantId, 'RESTAURANT');
  await seedTenantRoles(prisma, otherRestaurant.tenantId, 'RESTAURANT');
  await linkUsersToRoles(prisma, restaurant.tenantId);
  await linkUsersToRoles(prisma, otherRestaurant.tenantId);
  await prisma.tenantBusinessProfile.create({
    data: {
      tenantId: restaurant.tenantId,
      businessType: 'RESTAURANT',
      inventoryMode: 'LOCAL',
      accountingProvider: 'NONE',
    },
  });
  await prisma.tenantBusinessProfile.create({
    data: {
      tenantId: otherRestaurant.tenantId,
      businessType: 'RESTAURANT',
      inventoryMode: 'LOCAL',
      accountingProvider: 'NONE',
    },
  });

  // Fixture: dining area + one table + a session + an order (the D46
  // widening acts on `submitRound`, so every spec starts here).
  const area = await prisma.diningArea.create({
    data: { tenantId: restaurant.tenantId, branchId, name: 'Main' },
  });
  const table = await prisma.restaurantTable.create({
    data: {
      tenantId: restaurant.tenantId,
      branchId,
      areaId: area.id,
      code: 'T1',
      capacity: 4,
    },
  });
  tableId = table.id;
  const sessionRes = await http.request<{ id: string }>(
    'POST',
    `/restaurant/branches/${branchId}/table-sessions`,
    { token: ownerToken(restaurant), body: { tableId } },
  );
  sessionId = sessionRes.data.id;
  const orderRes = await http.request<{ id: string }>(
    'POST',
    `/restaurant/table-sessions/${sessionId}/orders`,
    { token: ownerToken(restaurant) },
  );
  orderId = orderRes.data.id;

  // Kitchen stations + a printer link so KOT generation has a target.
  const grill = await prisma.kitchenStation.create({
    data: { tenantId: restaurant.tenantId, branchId, code: 'GRILL', name: 'Grill' },
  });
  grillStationId = grill.id;
  const bar = await prisma.kitchenStation.create({
    data: { tenantId: restaurant.tenantId, branchId, code: 'BAR', name: 'Bar' },
  });
  barStationId = bar.id;

  // Simple Product (no variants) — routed to Bar.
  const simple = await prisma.product.create({
    data: {
      tenantId: restaurant.tenantId,
      name: 'Fresh Juice',
      type: 'Inventory',
      sku: 'RST-JUICE',
      unitPrice: '5.00',
      // D65 — rounds now DEPLETE StockItem lines at submit; a zero-stock
      // fixture would refuse every round in this spec, which is the depletion
      // spec's business (round-depletion.spec.ts), not this one's.
      quantityOnHand: '100.000',
      isActive: true,
    },
  });
  simpleProductId = simple.id;
  await prisma.productStationLink.create({
    data: { productId: simple.id, stationId: bar.id },
  });

  // Variant Product (Small / Medium / Large-inactive) — routed to Grill.
  const variantProduct = await prisma.product.create({
    data: {
      tenantId: restaurant.tenantId,
      name: 'Burger',
      type: 'Inventory',
      sku: 'RST-BURGER',
      unitPrice: '10.00', // legacy fallback — NOT what the variant charges
      quantityOnHand: '100.000', // D65 — see the Fresh Juice comment above
      hasVariants: true,
      isActive: true,
    },
  });
  variantProductId = variantProduct.id;
  await prisma.productStationLink.create({
    data: { productId: variantProduct.id, stationId: grill.id },
  });
  const sizeDim = await prisma.productVariationDimension.create({
    data: {
      tenantId: restaurant.tenantId,
      productId: variantProduct.id,
      name: 'Size',
      position: 0,
    },
  });
  const smallOpt = await prisma.productVariationOption.create({
    data: { tenantId: restaurant.tenantId, dimensionId: sizeDim.id, name: 'Small' },
  });
  const mediumOpt = await prisma.productVariationOption.create({
    data: { tenantId: restaurant.tenantId, dimensionId: sizeDim.id, name: 'Medium' },
  });
  const largeOpt = await prisma.productVariationOption.create({
    data: { tenantId: restaurant.tenantId, dimensionId: sizeDim.id, name: 'Large' },
  });
  const small = await prisma.productVariant.create({
    data: {
      tenantId: restaurant.tenantId,
      productId: variantProduct.id,
      sku: 'RST-BURGER-S',
      unitPrice: '8.50',
      isActive: true,
      isDefault: true,
    },
  });
  variantSmallId = small.id;
  await prisma.productVariantOptionValue.create({
    data: {
      tenantId: restaurant.tenantId,
      variantId: small.id,
      dimensionId: sizeDim.id,
      optionId: smallOpt.id,
    },
  });
  const medium = await prisma.productVariant.create({
    data: {
      tenantId: restaurant.tenantId,
      productId: variantProduct.id,
      sku: 'RST-BURGER-M',
      unitPrice: '12.50',
      isActive: true,
    },
  });
  variantMediumId = medium.id;
  await prisma.productVariantOptionValue.create({
    data: {
      tenantId: restaurant.tenantId,
      variantId: medium.id,
      dimensionId: sizeDim.id,
      optionId: mediumOpt.id,
    },
  });
  const large = await prisma.productVariant.create({
    data: {
      tenantId: restaurant.tenantId,
      productId: variantProduct.id,
      sku: 'RST-BURGER-L',
      unitPrice: '15.00',
      isActive: false,
    },
  });
  variantLargeInactiveId = large.id;
  await prisma.productVariantOptionValue.create({
    data: {
      tenantId: restaurant.tenantId,
      variantId: large.id,
      dimensionId: sizeDim.id,
      optionId: largeOpt.id,
    },
  });

  // Second variant Product — provides a variantId on a DIFFERENT Product
  // for the "variant not on product" negative.
  const other = await prisma.product.create({
    data: {
      tenantId: restaurant.tenantId,
      name: 'Pizza',
      type: 'Inventory',
      sku: 'RST-PIZZA',
      unitPrice: '20.00',
      hasVariants: true,
      isActive: true,
    },
  });
  const otherVariant = await prisma.productVariant.create({
    data: {
      tenantId: restaurant.tenantId,
      productId: other.id,
      sku: 'RST-PIZZA-S',
      unitPrice: '18.00',
      isActive: true,
    },
  });
  otherProductVariantId = otherVariant.id;

  // Inactive Product — sends `ProductInactiveError`.
  const inactive = await prisma.product.create({
    data: {
      tenantId: restaurant.tenantId,
      name: 'Retired Sandwich',
      type: 'Inventory',
      sku: 'RST-RETIRED',
      unitPrice: '7.00',
      isActive: false,
    },
  });
  inactiveProductId = inactive.id;

  // Modifier group + options — attached to variantProduct only.
  const attachedGroup = await prisma.modifierGroup.create({
    data: {
      tenantId: restaurant.tenantId,
      name: 'Cheese',
      selection: 'SINGLE',
      minSelections: 0,
      maxSelections: 1,
    },
  });
  attachedGroupId = attachedGroup.id;
  const attachedOption = await prisma.modifierOption.create({
    data: {
      tenantId: restaurant.tenantId,
      groupId: attachedGroup.id,
      name: 'Extra Cheese',
      priceDelta: '1.50',
    },
  });
  attachedOptionId = attachedOption.id;
  await prisma.productModifierGroup.create({
    data: { productId: variantProductId, modifierGroupId: attachedGroup.id },
  });
  // A second, UNATTACHED group in the same tenant — its option lives but
  // is not on any Product/MenuItem the round targets.
  const unattachedGroup = await prisma.modifierGroup.create({
    data: {
      tenantId: restaurant.tenantId,
      name: 'Sauce',
      selection: 'SINGLE',
      minSelections: 0,
      maxSelections: 1,
    },
  });
  const unattachedOption = await prisma.modifierOption.create({
    data: {
      tenantId: restaurant.tenantId,
      groupId: unattachedGroup.id,
      name: 'BBQ',
      priceDelta: '0.50',
    },
  });
  unattachedOptionId = unattachedOption.id;

  // Cross-tenant fixtures — Product + Variant on `otherRestaurant`.
  const xt = await prisma.product.create({
    data: {
      tenantId: otherRestaurant.tenantId,
      name: 'Cross Tenant Product',
      type: 'Inventory',
      sku: 'XT-P',
      unitPrice: '9.00',
      hasVariants: true,
      isActive: true,
    },
  });
  crossTenantProductId = xt.id;
  const xtv = await prisma.productVariant.create({
    data: {
      tenantId: otherRestaurant.tenantId,
      productId: xt.id,
      sku: 'XT-V',
      unitPrice: '9.00',
      isActive: true,
    },
  });
  crossTenantVariantId = xtv.id;
});

async function submitRound(body: unknown, tenant: SeededTenant = restaurant) {
  return http.request<{ id: string; itemIds: string[] }>(
    'POST',
    `/restaurant/orders/${orderId}/rounds`,
    { token: ownerToken(tenant), body },
  );
}

describe('D46 — submitRound accepts Product-sourced round items', () => {
  it('T1 (positive control): legacy MENU_ITEM path still works', async () => {
    // Fixture: one Menu / Section / MenuItem for the legacy path.
    const menu = await prisma.menu.create({
      data: { tenantId: restaurant.tenantId, branchId, name: 'Test Menu' },
    });
    const section = await prisma.menuSection.create({
      data: { tenantId: restaurant.tenantId, menuId: menu.id, name: 'Mains' },
    });
    const item = await prisma.menuItem.create({
      data: {
        tenantId: restaurant.tenantId,
        sectionId: section.id,
        name: 'Legacy Burger',
        basePrice: '12.50',
      },
    });

    const res = await submitRound({
      idempotencyKey: 't1',
      items: [{ menuItemId: item.id, quantity: 2 }],
    });
    expect(res.status).toBe(201);

    const row = await prisma.restaurantOrderItem.findFirstOrThrow({
      where: { roundId: res.data.id },
    });
    expect(row.sourceKind).toBe('MENU_ITEM');
    expect(row.menuItemId).toBe(item.id);
    expect(row.menuItemName).toBe('Legacy Burger');
    expect(row.unitPrice.toFixed(2)).toBe('12.50');
    expect(row.productId).toBeNull();
    expect(row.productVariantId).toBeNull();
    expect(row.variantNameSnapshot).toBeNull();
    expect(row.variantPriceSnapshot).toBeNull();
  });

  it('T2: PRODUCT-sourced without variantId, non-variant Product, succeeds', async () => {
    const res = await submitRound({
      idempotencyKey: 't2',
      items: [{ sourceKind: 'PRODUCT', productId: simpleProductId, quantity: 1 }],
    });
    expect(res.status).toBe(201);

    const row = await prisma.restaurantOrderItem.findFirstOrThrow({
      where: { roundId: res.data.id },
    });
    expect(row.sourceKind).toBe('PRODUCT');
    expect(row.productId).toBe(simpleProductId);
    // Loose-string reference — the Product id lands here for uniform reads.
    expect(row.menuItemId).toBe(simpleProductId);
    expect(row.menuItemName).toBe('Fresh Juice');
    expect(row.unitPrice.toFixed(2)).toBe('5.00');
    expect(row.productVariantId).toBeNull();
    expect(row.variantNameSnapshot).toBeNull();
    expect(row.variantPriceSnapshot).toBeNull();
  });

  it('T3: PRODUCT-sourced with variantId snapshots price + composed name', async () => {
    const res = await submitRound({
      idempotencyKey: 't3',
      items: [
        {
          sourceKind: 'PRODUCT',
          productId: variantProductId,
          productVariantId: variantMediumId,
          quantity: 1,
        },
      ],
    });
    expect(res.status).toBe(201);

    const row = await prisma.restaurantOrderItem.findFirstOrThrow({
      where: { roundId: res.data.id },
    });
    expect(row.sourceKind).toBe('PRODUCT');
    expect(row.productId).toBe(variantProductId);
    expect(row.productVariantId).toBe(variantMediumId);
    expect(row.variantNameSnapshot).toBe('Medium');
    // MUTATION PROOF: both the persisted `unitPrice` AND the snapshot
    // must be the variant's price (12.50), NOT the parent's (10.00) and
    // NOT a base+delta computation. A regression that used
    // `product.unitPrice + variantDelta` would keep the shape valid but
    // land 10.00 here.
    expect(row.unitPrice.toFixed(2)).toBe('12.50');
    expect(row.variantPriceSnapshot?.toFixed(2)).toBe('12.50');
    expect(row.unitPrice.toFixed(2)).not.toBe('10.00');
  });

  it('T4: PRODUCT with active variants but no variantId is REJECTED (VARIANT_SELECTION_REQUIRED)', async () => {
    const res = await submitRound({
      idempotencyKey: 't4',
      items: [{ sourceKind: 'PRODUCT', productId: variantProductId, quantity: 1 }],
    });
    expect(res.status).toBe(400);
    expect((res.body as { code: string }).code).toBe('VARIANT_SELECTION_REQUIRED');

    // POSITIVE CONTROL: no round row leaked into the DB.
    const count = await prisma.restaurantOrderItem.count({ where: { orderId } });
    expect(count).toBe(0);
  });

  it('T5: variantId that belongs to a DIFFERENT Product is REJECTED (VARIANT_NOT_ON_PRODUCT)', async () => {
    const res = await submitRound({
      idempotencyKey: 't5',
      items: [
        {
          sourceKind: 'PRODUCT',
          productId: variantProductId,
          productVariantId: otherProductVariantId,
          quantity: 1,
        },
      ],
    });
    expect(res.status).toBe(400);
    expect((res.body as { code: string }).code).toBe('VARIANT_NOT_ON_PRODUCT');
    expect(await prisma.restaurantOrderItem.count({ where: { orderId } })).toBe(0);
  });

  it('T6: INACTIVE variant is REJECTED (PRODUCT_VARIANT_INACTIVE)', async () => {
    const res = await submitRound({
      idempotencyKey: 't6',
      items: [
        {
          sourceKind: 'PRODUCT',
          productId: variantProductId,
          productVariantId: variantLargeInactiveId,
          quantity: 1,
        },
      ],
    });
    expect(res.status).toBe(400);
    expect((res.body as { code: string }).code).toBe('PRODUCT_VARIANT_INACTIVE');
    expect(await prisma.restaurantOrderItem.count({ where: { orderId } })).toBe(0);
  });

  it('T7: INACTIVE Product is REJECTED (PRODUCT_INACTIVE)', async () => {
    const res = await submitRound({
      idempotencyKey: 't7',
      items: [{ sourceKind: 'PRODUCT', productId: inactiveProductId, quantity: 1 }],
    });
    expect(res.status).toBe(400);
    expect((res.body as { code: string }).code).toBe('PRODUCT_INACTIVE');
    expect(await prisma.restaurantOrderItem.count({ where: { orderId } })).toBe(0);
  });

  it('T8: cross-tenant productId is REJECTED as PRODUCT_NOT_FOUND (no existence leak)', async () => {
    const res = await submitRound({
      idempotencyKey: 't8',
      items: [{ sourceKind: 'PRODUCT', productId: crossTenantProductId, quantity: 1 }],
    });
    expect(res.status).toBe(404);
    expect((res.body as { code: string }).code).toBe('PRODUCT_NOT_FOUND');
    expect(await prisma.restaurantOrderItem.count({ where: { orderId } })).toBe(0);
  });

  it('T9: cross-tenant productVariantId is REJECTED (PRODUCT_VARIANT_NOT_FOUND)', async () => {
    const res = await submitRound({
      idempotencyKey: 't9',
      items: [
        {
          sourceKind: 'PRODUCT',
          productId: variantProductId,
          productVariantId: crossTenantVariantId,
          quantity: 1,
        },
      ],
    });
    expect(res.status).toBe(404);
    expect((res.body as { code: string }).code).toBe('PRODUCT_VARIANT_NOT_FOUND');
    expect(await prisma.restaurantOrderItem.count({ where: { orderId } })).toBe(0);
  });

  it('T10: modifier option not attached to the Product is REJECTED (MODIFIER_OPTION_NOT_ON_ITEM)', async () => {
    // POSITIVE CONTROL (paired inside this test): the attached option
    // succeeds — proving the check is the group-attachment, not a blanket
    // refusal.
    const ok = await submitRound({
      idempotencyKey: 't10-ok',
      items: [
        {
          sourceKind: 'PRODUCT',
          productId: variantProductId,
          productVariantId: variantSmallId,
          quantity: 1,
          modifiers: [{ modifierOptionId: attachedOptionId }],
        },
      ],
    });
    expect(ok.status).toBe(201);

    const rej = await submitRound({
      idempotencyKey: 't10-rej',
      items: [
        {
          sourceKind: 'PRODUCT',
          productId: variantProductId,
          productVariantId: variantSmallId,
          quantity: 1,
          modifiers: [{ modifierOptionId: unattachedOptionId }],
        },
      ],
    });
    expect(rej.status).toBe(400);
    expect((rej.body as { code: string }).code).toBe('MODIFIER_OPTION_NOT_ON_ITEM');
    // Only the accepted round persisted a row — the rejected one didn't.
    const rows = await prisma.restaurantOrderItem.count({ where: { orderId } });
    expect(rows).toBe(1);
  });
});

describe('D46 — KitchenService widens station lookup + prints variant name', () => {
  it('K1: PRODUCT-sourced item routes to its ProductStationLink station', async () => {
    const res = await submitRound({
      idempotencyKey: 'k1',
      items: [
        {
          sourceKind: 'PRODUCT',
          productId: variantProductId,
          productVariantId: variantMediumId,
          quantity: 1,
        },
      ],
    });
    expect(res.status).toBe(201);

    // The variantProduct is linked ONLY to Grill.
    const tickets = await prisma.kitchenTicket.findMany({
      where: { roundId: res.data.id },
      include: { items: true },
    });
    expect(tickets).toHaveLength(1);
    expect(tickets[0].stationId).toBe(grillStationId);
    // Not Bar — sanity check the lookup didn't scan every station.
    expect(tickets[0].stationId).not.toBe(barStationId);
  });

  it('K2: PRODUCT-sourced item with NO station link falls into the silent unrouted bucket (no ticket)', async () => {
    // Drop the Grill link on this Product so it becomes unrouted.
    await prisma.productStationLink.deleteMany({
      where: { productId: variantProductId },
    });
    const res = await submitRound({
      idempotencyKey: 'k2',
      items: [
        {
          sourceKind: 'PRODUCT',
          productId: variantProductId,
          productVariantId: variantMediumId,
          quantity: 1,
        },
      ],
    });
    expect(res.status).toBe(201);
    // The round persisted (positive: item row exists) but NO KOT was
    // generated — matches the pre-D46 `__unrouted__` behaviour.
    expect(await prisma.restaurantOrderItem.count({ where: { roundId: res.data.id } })).toBe(1);
    expect(await prisma.kitchenTicket.count({ where: { roundId: res.data.id } })).toBe(0);
  });

  it('K3: KOT item for a variant-selected round item has variantName set to the snapshot', async () => {
    const res = await submitRound({
      idempotencyKey: 'k3',
      items: [
        {
          sourceKind: 'PRODUCT',
          productId: variantProductId,
          productVariantId: variantMediumId,
          quantity: 1,
        },
      ],
    });
    expect(res.status).toBe(201);

    const ktItems = await prisma.kitchenTicketItem.findMany({
      where: { ticket: { roundId: res.data.id } },
    });
    expect(ktItems).toHaveLength(1);
    expect(ktItems[0].variantName).toBe('Medium');
  });

  it('K4: KOT item for a MENU_ITEM-sourced round item has variantName NULL', async () => {
    const menu = await prisma.menu.create({
      data: { tenantId: restaurant.tenantId, branchId, name: 'Menu2' },
    });
    const section = await prisma.menuSection.create({
      data: { tenantId: restaurant.tenantId, menuId: menu.id, name: 'Mains' },
    });
    const item = await prisma.menuItem.create({
      data: {
        tenantId: restaurant.tenantId,
        sectionId: section.id,
        name: 'Legacy',
        basePrice: '6.00',
      },
    });
    // Route the MenuItem to a station so a KOT actually gets generated.
    await prisma.menuItemStationLink.create({
      data: { menuItemId: item.id, stationId: grillStationId },
    });

    const res = await submitRound({
      idempotencyKey: 'k4',
      items: [{ menuItemId: item.id, quantity: 1 }],
    });
    expect(res.status).toBe(201);
    const ktItems = await prisma.kitchenTicketItem.findMany({
      where: { ticket: { roundId: res.data.id } },
    });
    expect(ktItems).toHaveLength(1);
    expect(ktItems[0].variantName).toBeNull();
  });
});
