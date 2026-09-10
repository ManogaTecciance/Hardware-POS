/**
 * D46 — `submitRound` widening.
 *
 * Phase 1 landed the schema. This spec covers the service behaviour behind
 * the D46 wire: a round can now carry MENU_ITEM-sourced items (legacy
 * default) AND PRODUCT-sourced items with an optional ProductVariant
 * selection. The service resolves each source to a uniform snapshot, and
 * `KitchenService.generateTicketsForRound` reads the appropriate station-link
 * junction and copies that snapshot onto each station's KOT.
 *
 * The K-series has been rewritten twice, and this is the second. D147 removed
 * the station split, so K1 stopped asserting "routes to its
 * `ProductStationLink` station" and K2 stopped asserting anything about where
 * an unlinked dish went. D152 supersedes D147 and puts the split back, with
 * the thing that was missing under the original routing: an item that routes
 * to nothing lands on the branch's MAIN station. So K1 asserts the lookup
 * again, and K2 — which asserted zero tickets before D147, "the silent
 * unrouted bucket", pinned as correct — now asserts the Main ticket that
 * makes the drop impossible.
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
 *   • The K-series asserts D152 with the station links IN PLACE and asserted
 *     present. "Two tickets, one per station" is worth nothing against a
 *     fixture with nothing to route on — a build that ignored the junctions
 *     entirely would put both dishes on one Main ticket and could not be told
 *     apart by a count.
 *   • K2 additionally asserts, BEFORE the round, that the branch has more
 *     than one active station and no MAIN row. A branch with exactly one
 *     active station was the single case in which the retired D67 routing did
 *     not drop an unlinked dish, so without that assertion the test would
 *     pass against the old behaviour too; and without the second, "it landed
 *     on Main" would not prove Main was created rather than found.
 *   • K5 asserts the UNION: the multiset of the tickets' items against the
 *     round's own. Ticket counts can be right while a line is missing, which
 *     is exactly the failure D147 removed the split over.
 *   • K1/K3/K4/K5 keep mirroring the round-item table against the
 *     KitchenTicketItem table, so a snapshot regression on the widened source
 *     reads (Product vs MenuItem) surfaces on both sides.
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

  /*
   * Two kitchen stations, with two products linked to different ones. D152 —
   * they ROUTE again, one ticket each; and the branch having more than one
   * active station is what makes K2 meaningful, that being the condition
   * under which the retired D67 routing dropped a dish linked to none.
   *
   * Neither is coded `MAIN`, deliberately: Main does not exist at this branch
   * until a round is submitted, which is what lets K2 assert it was CREATED.
   */
  const grill = await prisma.kitchenStation.create({
    data: { tenantId: restaurant.tenantId, branchId, code: 'GRILL', name: 'Grill' },
  });
  grillStationId = grill.id;
  const bar = await prisma.kitchenStation.create({
    data: { tenantId: restaurant.tenantId, branchId, code: 'BAR', name: 'Bar' },
  });
  barStationId = bar.id;

  // Simple Product (no variants) — linked to Bar. D152: the link routes, and
  // K1 asserts both the ticket it produces and the link itself.
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

  // Variant Product (Small / Medium / Large-inactive) — linked to Grill, on
  // the same terms as Fresh Juice above. K2 deletes this link to make the
  // unrouted case, which is why it is asserted gone there before the round.
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

/*
 * D46 + D152 — one KOT per STATION, each carrying its own dishes and their
 * variants.
 *
 * D147 had collapsed the K-series to "one ticket per round, belonging to no
 * station". D152 supersedes it and this block goes back to asserting the
 * routing, with the one thing that was missing before: an item that routes to
 * nothing lands on the branch's Main station instead of being dropped, which
 * is what K2 used to pin as CORRECT ("the silent unrouted bucket", zero
 * tickets) and now pins as impossible.
 *
 * The station links stay in the fixture throughout and are asserted PRESENT,
 * because that is what separates these tests from vacuous ones: "two tickets,
 * one per station" against a fixture that linked nothing would be green
 * against a build that had simply stopped consulting the junctions.
 */
describe('D46/D152 — one KOT per station, carrying its dishes and their variants', () => {
  const ticketsFor = (roundId: string) =>
    prisma.kitchenTicket.findMany({
      where: { roundId },
      include: { items: true, station: true },
    });

  /** `{ Grill: ['Burger'], … }` — which station received which dishes. */
  const dishesByStation = (rows: Awaited<ReturnType<typeof ticketsFor>>) =>
    Object.fromEntries(
      rows.map((t) => [
        // '(no station)' rather than a throw: a D147-window ticket legitimately
        // carries none, so a regression that produced one here must READ as
        // that rather than as a crashed test.
        t.station?.name ?? '(no station)',
        t.items.map((i) => i.menuItemName).sort(),
      ]),
    );

  /*
   * NOTHING IS DROPPED, as a multiset: what the KITCHEN received against what
   * the WAITER sent. Dish names alone would let a lost second helping through,
   * so the key carries every field a KOT line copies from its round line — the
   * D46 variant snapshot and the quantity included.
   */
  const sentByTheWaiter = async (roundId: string) =>
    (
      await prisma.restaurantOrderItem.findMany({
        where: { roundId },
        select: { menuItemName: true, variantNameSnapshot: true, quantity: true },
      })
    )
      .map((i) => `${i.menuItemName}|${i.variantNameSnapshot ?? '—'}|${i.quantity.toFixed(3)}`)
      .sort();

  const receivedByTheKitchen = async (roundId: string) =>
    (
      await prisma.kitchenTicketItem.findMany({
        where: { ticket: { roundId } },
        select: { menuItemName: true, variantName: true, quantity: true },
      })
    )
      .map((i) => `${i.menuItemName}|${i.variantName ?? '—'}|${i.quantity.toFixed(3)}`)
      .sort();

  const mainStation = () =>
    prisma.kitchenStation.findFirstOrThrow({ where: { branchId, code: 'MAIN' } });

  it('K1: a round spanning TWO stations is TWO tickets, one per station', async () => {
    const res = await submitRound({
      idempotencyKey: 'k1',
      items: [
        // Linked to Grill…
        {
          sourceKind: 'PRODUCT',
          productId: variantProductId,
          productVariantId: variantMediumId,
          quantity: 1,
        },
        // …and linked to Bar. Two stations, one round: two cards on the pass.
        { sourceKind: 'PRODUCT', productId: simpleProductId, quantity: 1 },
      ],
    });
    expect(res.status).toBe(201);

    const tickets = await ticketsFor(res.data.id);
    // POSITIVE — two tickets, each holding ONLY its own station's dish. This
    // assertion replaces D147's `toHaveLength(1)` + `stationId === null`,
    // which D152 made false rather than merely inconvenient.
    expect(tickets).toHaveLength(2);
    expect(dishesByStation(tickets)).toEqual({ Grill: ['Burger'], Bar: ['Fresh Juice'] });
    // The same claim on the IDS, so it cannot pass on two stations that happen
    // to share a display name.
    expect([...tickets.map((t) => t.stationId)].sort()).toEqual(
      [grillStationId, barStationId].sort(),
    );

    // NEGATIVE — the two shapes this replaces: no ticket holds both dishes
    // (the D147 collapse), and none belongs to no station.
    expect(tickets.some((t) => t.items.length > 1)).toBe(false);
    expect(tickets.every((t) => t.stationId !== null)).toBe(true);
    // Two cards on the pass are two KOT numbers: two cards sharing one cannot
    // be told apart by the people calling them out.
    expect(new Set(tickets.map((t) => t.ticketNumber)).size).toBe(2);

    // D46, UNCHANGED by either decision: the variant snapshot is on the KOT
    // line, and only on the line that has a variant — now on the ticket that
    // dish actually routed to.
    const grill = tickets.find((t) => t.stationId === grillStationId)!;
    const bar = tickets.find((t) => t.stationId === barStationId)!;
    expect(grill.items[0]!.variantName).toBe('Medium');
    expect(bar.items[0]!.variantName).toBeNull();

    /*
     * NOTHING DROPPED between the two of them. The content is pinned rather
     * than merely compared, because two equal EMPTY lists would satisfy the
     * comparison — a generator that wrote no items must fail here.
     */
    const roundLines = await sentByTheWaiter(res.data.id);
    expect(roundLines).toEqual(['Burger|Medium|1.000', 'Fresh Juice|—|1.000']);
    expect(await receivedByTheKitchen(res.data.id)).toEqual(roundLines);

    /*
     * POSITIVE CONTROL (D30) — the links the lookup routes on are still there,
     * on two DIFFERENT stations. Without this, everything above would pass
     * unchanged against a fixture that had nothing to split by — and a build
     * that ignored the junctions would put both dishes on one Main ticket.
     */
    const links = await prisma.productStationLink.findMany({
      where: { productId: { in: [variantProductId, simpleProductId] } },
      select: { stationId: true },
    });
    expect(links.map((l) => l.stationId).sort()).toEqual([grillStationId, barStationId].sort());
  });

  it('K2: an item with NO station link lands on MAIN — it used to reach the kitchen on none', async () => {
    /*
     * THE DEFECT D147 REMOVED THE SPLIT OVER, and the reason D152 could put
     * the split back. The old routing dropped an item with no station link
     * ENTIRELY unless the branch had exactly one active station; this branch
     * has two, so the dish was ordered, billed and never cooked.
     *
     * This test asserted that outcome as CORRECT before D147 —
     * `kitchenTicket.count === 0`, described as "the silent unrouted bucket".
     * D152 makes it impossible: Main is upserted on every submit and is what
     * an empty link list falls back to.
     */
    await prisma.productStationLink.deleteMany({
      where: { productId: variantProductId },
    });

    /*
     * The preconditions, ASSERTED BEFORE THE ROUND rather than assumed (D30),
     * because the submit itself changes two of them — it creates Main, taking
     * the branch from two active stations to three:
     *   • the dish genuinely has no station link,
     *   • the branch has more than one active station, so D67's retired
     *     sole-station sweep could not have rescued it either, and
     *   • there is no MAIN row yet, so what lands below was CREATED here.
     */
    expect(await prisma.productStationLink.count({ where: { productId: variantProductId } })).toBe(
      0,
    );
    expect(await prisma.kitchenStation.count({ where: { branchId, isActive: true } })).toBe(2);
    expect(await prisma.kitchenStation.count({ where: { branchId, code: 'MAIN' } })).toBe(0);

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

    // POSITIVE — the round persisted AND the dish is on a ticket, at Main.
    expect(await prisma.restaurantOrderItem.count({ where: { roundId: res.data.id } })).toBe(1);
    const main = await mainStation();
    const tickets = await ticketsFor(res.data.id);
    expect(tickets).toHaveLength(1);
    expect(tickets[0]!.stationId).toBe(main.id);
    expect(tickets[0]!.items.map((i) => i.menuItemName)).toEqual(['Burger']);
    // The snapshot survives the round trip for an unlinked dish too.
    expect(tickets[0]!.items[0]!.variantName).toBe('Medium');

    // Main is what the contract says it is, and it is REACHABLE — an archived
    // Main would take tickets while vanishing from the board's station filter.
    expect({
      code: main.code,
      name: main.name,
      category: main.category,
      isActive: main.isActive,
    }).toEqual({ code: 'MAIN', name: 'Main', category: 'KITCHEN', isActive: true });

    // NEGATIVE — it is Main it fell back to, not one of the stations it is no
    // longer linked to. A generator that swept the branch for "some active
    // station" would land here and pass every other assertion above.
    expect(tickets[0]!.stationId).not.toBe(grillStationId);
    expect(tickets[0]!.stationId).not.toBe(barStationId);
    expect(await prisma.kitchenStation.count({ where: { branchId, isActive: true } })).toBe(3);

    // …and the single line survives intact, pinned rather than compared, so
    // two equal empty lists cannot satisfy it.
    const roundLines = await sentByTheWaiter(res.data.id);
    expect(roundLines).toEqual(['Burger|Medium|1.000']);
    expect(await receivedByTheKitchen(res.data.id)).toEqual(roundLines);
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

  it('K4: MENU_ITEM-sourced rows route on their own junction, and the unrouted one goes to Main', async () => {
    const menu = await prisma.menu.create({
      data: { tenantId: restaurant.tenantId, branchId, name: 'Menu2' },
    });
    const section = await prisma.menuSection.create({
      data: { tenantId: restaurant.tenantId, menuId: menu.id, name: 'Mains' },
    });
    const mkItem = (name: string, basePrice: string) =>
      prisma.menuItem.create({
        data: { tenantId: restaurant.tenantId, sectionId: section.id, name, basePrice },
      });
    const linked = await mkItem('Legacy', '6.00');
    const unlinked = await mkItem('Legacy Unrouted', '7.00');
    /*
     * D60 — a MenuItem with no `productId` is the one line that still routes
     * through `MenuItemStationLink`, so the link stays on ONE of the two: the
     * legacy junction is proven to route (Legacy → Grill) and the Main
     * fallback is proven to catch the other (Legacy Unrouted → Main) in the
     * same round. D147 had put both on one stationless ticket.
     */
    await prisma.menuItemStationLink.create({
      data: { menuItemId: linked.id, stationId: grillStationId },
    });

    const res = await submitRound({
      idempotencyKey: 'k4',
      items: [
        { menuItemId: linked.id, quantity: 1 },
        { menuItemId: unlinked.id, quantity: 1 },
      ],
    });
    expect(res.status).toBe(201);

    const main = await mainStation();
    const tickets = await ticketsFor(res.data.id);
    // POSITIVE — two tickets: the legacy junction routed one, Main caught the
    // other, and the UNLINKED row reached the kitchen rather than nothing.
    expect(tickets).toHaveLength(2);
    expect(dishesByStation(tickets)).toEqual({
      Grill: ['Legacy'],
      Main: ['Legacy Unrouted'],
    });
    expect([...tickets.map((t) => t.stationId)].sort()).toEqual([grillStationId, main.id].sort());

    // NEGATIVE — neither carries a variant name: a MENU_ITEM row has no
    // variant, and the kitchen must not infer one from price (D46, unchanged).
    expect(tickets.flatMap((t) => t.items.map((i) => i.variantName))).toEqual([null, null]);
    // …and neither ticket belongs to no station, which is the D147 shape.
    expect(tickets.every((t) => t.stationId !== null)).toBe(true);

    const roundLines = await sentByTheWaiter(res.data.id);
    expect(roundLines).toEqual(['Legacy Unrouted|—|1.000', 'Legacy|—|1.000']);
    expect(await receivedByTheKitchen(res.data.id)).toEqual(roundLines);

    // POSITIVE CONTROL for the Grill ticket above — the legacy link is really
    // there, pointing at Grill, so 'Grill' is the junction's doing and not a
    // second fallback.
    expect(
      await prisma.menuItemStationLink.count({
        where: { menuItemId: linked.id, stationId: grillStationId },
      }),
    ).toBe(1);
    // …and its NEGATIVE twin: the unrouted item has no link of its own, so
    // 'Main' is the fallback's doing rather than a link nobody noticed.
    expect(await prisma.menuItemStationLink.count({ where: { menuItemId: unlinked.id } })).toBe(0);
  });

  it('K5: NOTHING IS DROPPED — the tickets of a round spanning both junctions hold exactly its items', async () => {
    /*
     * The union claim over the widest round this fixture can make: a
     * PRODUCT-sourced dish on Grill, another on Bar, a PRODUCT-sourced dish
     * linked to nothing, and a legacy MENU_ITEM row linked to nothing. Four
     * lines, three stations, both junctions and the fallback — the shape where
     * a routing bug is most likely to lose a line quietly.
     *
     * Card counts can be right while a dish is missing. This is the assertion
     * that cannot be satisfied by a lucky fixture: the multiset of what the
     * kitchen received IS the multiset of what the waiter sent.
     */
    const orphan = await prisma.product.create({
      data: {
        tenantId: restaurant.tenantId,
        name: 'Papadum',
        type: 'Inventory',
        sku: 'RST-PAPADUM',
        unitPrice: '2.00',
        quantityOnHand: '100.000', // D65 — see the Fresh Juice comment above
        isActive: true,
      },
    });
    const menu = await prisma.menu.create({
      data: { tenantId: restaurant.tenantId, branchId, name: 'Menu3' },
    });
    const section = await prisma.menuSection.create({
      data: { tenantId: restaurant.tenantId, menuId: menu.id, name: 'Sides' },
    });
    const legacyOrphan = await prisma.menuItem.create({
      data: {
        tenantId: restaurant.tenantId,
        sectionId: section.id,
        name: 'Legacy Side',
        basePrice: '3.00',
      },
    });

    const res = await submitRound({
      idempotencyKey: 'k5',
      items: [
        {
          sourceKind: 'PRODUCT',
          productId: variantProductId,
          productVariantId: variantMediumId,
          quantity: 2,
        }, // → Grill
        { sourceKind: 'PRODUCT', productId: simpleProductId, quantity: 3 }, // → Bar
        { sourceKind: 'PRODUCT', productId: orphan.id, quantity: 4 }, // → Main
        { menuItemId: legacyOrphan.id, quantity: 5 }, // → Main, same ticket
      ],
    });
    expect(res.status).toBe(201);

    const main = await mainStation();
    const tickets = await ticketsFor(res.data.id);
    // POSITIVE — three tickets for four lines: the two orphans share Main
    // rather than getting a card each.
    expect(tickets).toHaveLength(3);
    expect(dishesByStation(tickets)).toEqual({
      Grill: ['Burger'],
      Bar: ['Fresh Juice'],
      Main: ['Legacy Side', 'Papadum'],
    });
    expect([...tickets.map((t) => t.stationId)].sort()).toEqual(
      [grillStationId, barStationId, main.id].sort(),
    );

    // THE UNION — every line of the round, on some ticket, with its quantity
    // and its variant intact.
    const sent = await sentByTheWaiter(res.data.id);
    expect(sent).toHaveLength(4);
    expect(await receivedByTheKitchen(res.data.id)).toEqual(sent);
    expect(sent).toEqual(
      [
        'Burger|Medium|2.000',
        'Fresh Juice|—|3.000',
        'Legacy Side|—|5.000',
        'Papadum|—|4.000',
      ].sort(),
    );

    // NEGATIVE — neither shape this replaces: not one collapsed card (D147),
    // and not a card per line (which is what "Main aggregates" rules out).
    expect(tickets.some((t) => t.items.length === 4)).toBe(false);
    expect(new Set(tickets.map((t) => t.ticketNumber)).size).toBe(3);
    expect(tickets.every((t) => t.stationId !== null)).toBe(true);

    // POSITIVE CONTROLS (D30) — two links, on two DIFFERENT stations, still
    // present; and two lines genuinely linked to nothing on either junction,
    // at a branch with three active stations, so no sole-station sweep could
    // have placed them.
    const links = await prisma.productStationLink.findMany({
      where: { productId: { in: [variantProductId, simpleProductId] } },
      select: { stationId: true },
    });
    expect(links.map((l) => l.stationId).sort()).toEqual([grillStationId, barStationId].sort());
    expect(await prisma.productStationLink.count({ where: { productId: orphan.id } })).toBe(0);
    expect(await prisma.menuItemStationLink.count({ where: { menuItemId: legacyOrphan.id } })).toBe(
      0,
    );
    expect(await prisma.kitchenStation.count({ where: { branchId, isActive: true } })).toBe(3);
  });
});
