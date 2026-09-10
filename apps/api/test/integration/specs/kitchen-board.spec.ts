/**
 * D68 — the kitchen board replaces the kitchen printer.
 *
 * What this covers is the whole delivery path: a waiter sends a round, and
 * the food appears on a screen somebody is rostered to. There is no printer
 * behind it, which is the point — so the assertions are about the ROW being
 * complete and reachable, and about who is allowed to touch it.
 *
 * D30 compliance:
 *
 *   • Every "printing is gone" negative is paired with a positive that the
 *     ticket itself exists and carries its context. A spec that only asserted
 *     "no print attempts" would pass just as happily against a build that
 *     generated no tickets at all.
 *   • The permission tests assert BOTH directions on the same user: kitchen
 *     staff can complete a ticket AND are refused the till. A one-sided test
 *     passes against a role that holds nothing, and against one that holds
 *     everything, respectively.
 *   • Idempotency is proven by identity of the recorded completer, not by
 *     absence of an error — a second call that silently rewrote the name
 *     would still "succeed".
 *   • D147's "one card per round" is asserted on the ROWS as well as on the
 *     board, and always with the station links the retired split routed on
 *     left in the fixture and asserted PRESENT. "One ticket, belonging to no
 *     station" proves nothing against a fixture that had nothing to route on
 *     — it would be green against the very routing it exists to prove gone.
 */
import {
  seedTenantRoles,
  syncPermissionCatalogue,
  linkUsersToRoles,
} from '@hardware-pos/database';
import type { PrismaClient } from '@hardware-pos/database';

import { connectTestPrisma, disconnectTestPrisma } from '../prisma-test-client';
import { resetDatabase } from '../db-reset';
import { seedSecondTenant, type SeededTenant } from '../fixtures';
import { createHttpIntegrationApp, type HttpIntegrationApp } from '../http-test-app';

let prisma: PrismaClient;
let http: HttpIntegrationApp;
let restaurant: SeededTenant;
let branchId: string;
let sessionId: string;
let orderId: string;
let productId: string;
let stationId: string;
/** A user holding the D68 KITCHEN_STAFF role row — not the OWNER. */
let kitchenUserId: string;

interface TicketView {
  id: string;
  ticketNumber: string;
  status: string;
  /**
   * D147 — NULL on every ticket this spec cuts: a round is one ticket now, and
   * a ticket that belongs to no station must not claim one. It stays on the
   * wire (retyped) because a ticket raised BEFORE D147 genuinely still carries
   * the station it was routed to. `stationName` is gone from the view
   * altogether, so it is deliberately NOT declared here; the tests assert its
   * absence from the payload rather than trusting this type.
   */
  stationId: string | null;
  orderNumber: string | null;
  placeLabel: string | null;
  roundNumber: number | null;
  waiterName: string | null;
  completedAt: string | null;
  completedByName: string | null;
  items: { menuItemName: string; quantity: string; specialInstructions: string | null }[];
}

const ownerToken = () =>
  http.tokenFor({
    userId: restaurant.ownerId,
    tenantId: restaurant.tenantId,
    role: 'OWNER',
    activeBranchId: branchId,
  });

/*
 * The kitchen user's JWT claims CASHIER — exactly as the seed creates them,
 * because there is no `UserRole.KITCHEN_STAFF` enum value. Authority
 * therefore has to come from the linked role ROW; if it ever fell back to
 * the enum, this user would resolve as a full cashier and the refusal tests
 * below would fail. That is the point of using this token for both halves.
 */
const kitchenToken = () =>
  http.tokenFor({
    userId: kitchenUserId,
    tenantId: restaurant.tenantId,
    role: 'CASHIER',
    activeBranchId: branchId,
  });

async function sendRound(instructions: string | null = null) {
  return http.request<{ id: string }>('POST', `/restaurant/orders/${orderId}/rounds`, {
    token: ownerToken(),
    body: {
      idempotencyKey: `round-${Math.floor(performance.now() * 1000)}`,
      items: [
        {
          sourceKind: 'PRODUCT',
          productId,
          quantity: '2',
          ...(instructions ? { specialInstructions: instructions } : {}),
        },
      ],
    },
  });
}

const board = (query = '') =>
  http.request<TicketView[]>(
    'GET',
    `/restaurant/branches/${branchId}/kitchen-tickets${query}`,
    { token: kitchenToken() },
  );

/** D142b — the three lane chips' numbers. */
const laneCounts = () =>
  http.request<{ toMake: number; preparing: number; doneToday: number }>(
    'GET',
    `/restaurant/branches/${branchId}/kitchen-tickets/counts`,
    { token: kitchenToken() },
  );

/** D142 — the paged history, read as the kitchen reads it. */
const history = (query = '') =>
  http.request<{ items: TicketView[]; total: number; page: number; pageSize: number }>(
    'GET',
    `/restaurant/branches/${branchId}/kitchen-tickets/history${query}`,
    { token: kitchenToken() },
  );

/** Bump a ticket, as the pass does. */
async function bump(ticketId: string) {
  return http.request<TicketView>(
    'POST',
    `/restaurant/branches/${branchId}/kitchen-tickets/${ticketId}/complete`,
    { token: kitchenToken() },
  );
}

/**
 * Move a bumped ticket back in time.
 *
 * The only way to have "yesterday's service" inside one test: the API has no
 * verb for it, deliberately — `completedAt` is written by the bump and by
 * nothing else.
 */
async function backdate(ticketId: string, days: number) {
  const at = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  await prisma.kitchenTicket.update({ where: { id: ticketId }, data: { completedAt: at } });
  return at;
}

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
  branchId = restaurant.branchId;

  await syncPermissionCatalogue(prisma);
  await seedTenantRoles(prisma, restaurant.tenantId, 'RESTAURANT');
  await linkUsersToRoles(prisma, restaurant.tenantId);
  await prisma.tenantBusinessProfile.create({
    data: {
      tenantId: restaurant.tenantId,
      businessType: 'RESTAURANT',
      inventoryMode: 'LOCAL',
      accountingProvider: 'NONE',
    },
  });

  const kitchenRole = await prisma.role.findFirstOrThrow({
    where: { tenantId: restaurant.tenantId, key: 'KITCHEN_STAFF' },
    select: { id: true },
  });
  const kitchenUser = await prisma.user.create({
    data: {
      tenantId: restaurant.tenantId,
      name: 'Chef Fixture',
      email: 'chef@fixture.test',
      role: 'CASHIER',
      roleId: kitchenRole.id,
      branchId,
    },
  });
  kitchenUserId = kitchenUser.id;

  const area = await prisma.diningArea.create({
    data: { tenantId: restaurant.tenantId, branchId, name: 'Terrace' },
  });
  const table = await prisma.restaurantTable.create({
    data: { tenantId: restaurant.tenantId, branchId, areaId: area.id, code: 'T7', capacity: 4 },
  });
  const sessionRes = await http.request<{ id: string }>(
    'POST',
    `/restaurant/branches/${branchId}/table-sessions`,
    { token: ownerToken(), body: { tableId: table.id } },
  );
  sessionId = sessionRes.data.id;
  const orderRes = await http.request<{ id: string }>(
    'POST',
    `/restaurant/table-sessions/${sessionId}/orders`,
    { token: ownerToken() },
  );
  orderId = orderRes.data.id;

  const station = await prisma.kitchenStation.create({
    data: { tenantId: restaurant.tenantId, branchId, code: 'PASS', name: 'Pass' },
  });
  stationId = station.id;
  const product = await prisma.product.create({
    data: {
      tenantId: restaurant.tenantId,
      name: 'Beef Steak',
      type: 'Inventory',
      sku: 'RST-STEAK',
      unitPrice: '3200.00',
      quantityOnHand: '100.000',
      isActive: true,
    },
  });
  productId = product.id;
  /*
   * D147 — this link is left here ON PURPOSE and the tests assert it is still
   * present. Station links did not go away; they stopped routing. Asserting
   * "the ticket belongs to no station" against a fixture that had never linked
   * anything would be a vacuous test (D30).
   */
  await prisma.productStationLink.create({ data: { productId: product.id, stationId } });
});

describe('D68 — a sent round lands on the kitchen board', () => {
  it('creates a ticket carrying where the food is going, and queues no print work', async () => {
    const sent = await sendRound('no pepper');
    expect(sent.status).toBe(201);

    const res = await board();
    expect(res.status).toBe(200);
    expect(res.data).toHaveLength(1);

    // POSITIVE — the ticket is the delivery, so it has to be legible on its
    // own: a dish the pass cannot place never leaves the kitchen.
    const ticket = res.data[0]!;
    expect(ticket.status).toBe('QUEUED');
    /*
     * D147 — this assertion read `stationName === 'Pass'` and is now false by
     * decision: the card names no station. The product IS linked to Pass (the
     * fixture makes that link, and the row read below asserts it survives),
     * which is what makes the null meaningful rather than incidental.
     */
    expect(ticket.stationId).toBeNull();
    expect(ticket).not.toHaveProperty('stationName');
    expect(ticket.placeLabel).toBe('T7 · Terrace');
    expect(ticket.orderNumber).toMatch(/^RO-\d+$/);
    expect(ticket.roundNumber).toBe(1);
    expect(ticket.items).toHaveLength(1);
    expect(ticket.items[0]!.menuItemName).toBe('Beef Steak');
    expect(ticket.items[0]!.specialInstructions).toBe('no pepper');

    // NEGATIVE — nothing was queued for a printer. Paired with the positives
    // above: this cannot pass by virtue of no ticket having been generated.
    const attempts = await prisma.kitchenPrintAttempt.count({
      where: { tenantId: restaurant.tenantId },
    });
    expect({ ticketsOnBoard: res.data.length, printAttempts: attempts }).toEqual({
      ticketsOnBoard: 1,
      printAttempts: 0,
    });
    const stored = await prisma.kitchenTicket.findFirstOrThrow({
      where: { tenantId: restaurant.tenantId },
      select: { primaryPrinterId: true, stationId: true },
    });
    expect(stored.primaryPrinterId).toBeNull();
    // D147 in the COLUMN, not only in the projection.
    expect(stored.stationId).toBeNull();
    // POSITIVE CONTROL for that null: the link exists and was simply not
    // consulted. Without it the null would also hold for a fixture that had
    // nothing to consult.
    expect(await prisma.productStationLink.count({ where: { productId, stationId } })).toBe(1);
  });

  it('a second round is a second ticket, numbered as round 2', async () => {
    await sendRound();
    await sendRound();
    const res = await board();
    // D147 collapsed the STATION split and nothing else: two rounds are still
    // two cards, and an order is never folded into a single ticket.
    expect(res.data).toHaveLength(2);
    expect(res.data.map((t) => t.roundNumber).sort()).toEqual([1, 2]);
    // Oldest first: a kitchen works a queue.
    expect(res.data[0]!.roundNumber).toBe(1);
  });
});

/*
 * D147 — a round is ONE card, whatever its dishes would have routed to.
 *
 * The board used to show a single order for a single round as several
 * separate cards, one per kitchen station the items routed to (RO-000026, one
 * round of 15 lines, arrived as KOT-000027 with 13 and KOT-000028 with 2).
 * The routing behind that was never reachable — the only place to link a dish
 * to a station is the product wizard's branch-scoped Step 3 multi-select,
 * which renders empty when no branch is selected — and worse than
 * unreachable: an item with no link was DROPPED unless the branch happened to
 * have exactly one active station.
 *
 * So this block is deliberately hostile to the claim it makes. Four active
 * stations, three products linked to three DIFFERENT ones, and a fourth
 * linked to nothing: the exact fixture the retired routing would have split
 * three ways while silently losing the fourth dish.
 */
describe('D147 — a round is one card, whatever its dishes would have routed to', () => {
  let grillProductId: string;
  let pastryProductId: string;
  let unlinkedProductId: string;

  const mkProduct = async (name: string, sku: string, station: string | null) => {
    const product = await prisma.product.create({
      data: {
        tenantId: restaurant.tenantId,
        name,
        type: 'Inventory',
        sku,
        unitPrice: '900.00',
        // D65 — a round DEPLETES stock at submit, so a zero-stock fixture
        // would be refused before it ever reached the kitchen.
        quantityOnHand: '100.000',
        isActive: true,
      },
    });
    if (station) {
      await prisma.productStationLink.create({
        data: { productId: product.id, stationId: station },
      });
    }
    return product.id;
  };

  beforeEach(async () => {
    /*
     * FOUR active stations, the shape of the branch that reported this (Bar,
     * Grill, Main Kitchen, Pastry — the outer fixture's 'Pass' stands in for
     * the fourth). The COUNT is load-bearing: the routing D147 removed had
     * exactly one escape hatch for a dish linked to nothing, and it was a
     * branch with exactly ONE active station. At four there was no escape.
     */
    const mkStation = async (code: string, name: string) =>
      (
        await prisma.kitchenStation.create({
          data: { tenantId: restaurant.tenantId, branchId, code, name },
        })
      ).id;
    const grillId = await mkStation('GRILL', 'Grill');
    const pastryId = await mkStation('PASTRY', 'Pastry');
    await mkStation('MAIN', 'Main Kitchen');

    grillProductId = await mkProduct('Grilled Seer Fish', 'RST-SEER', grillId);
    pastryProductId = await mkProduct('Watalappan', 'RST-WATA', pastryId);
    // Linked to nothing at all. This is the ORDINARY case rather than a corner
    // one: with the wizard's multi-select empty, every product is created this
    // way.
    unlinkedProductId = await mkProduct('Chicken Kottu', 'RST-KOTTU', null);
  });

  const sendMixedRound = () =>
    http.request<{ id: string }>('POST', `/restaurant/orders/${orderId}/rounds`, {
      token: ownerToken(),
      body: {
        idempotencyKey: 'd143-mixed',
        items: [
          // Pass, Grill, Pastry — and one dish belonging to no station.
          { sourceKind: 'PRODUCT', productId, quantity: '1' },
          { sourceKind: 'PRODUCT', productId: grillProductId, quantity: '1' },
          { sourceKind: 'PRODUCT', productId: pastryProductId, quantity: '1' },
          { sourceKind: 'PRODUCT', productId: unlinkedProductId, quantity: '1' },
        ],
      },
    });

  it('shows one card holding every dish, where three stations meant three cards', async () => {
    const sent = await sendMixedRound();
    expect(sent.status).toBe(201);

    // POSITIVE — one card on the board, carrying the whole round.
    const cards = (await board('?status=OUTSTANDING')).data;
    expect(cards).toHaveLength(1);
    expect(cards[0]!.items.map((i) => i.menuItemName).sort()).toEqual([
      'Beef Steak',
      'Chicken Kottu',
      'Grilled Seer Fish',
      'Watalappan',
    ]);

    /*
     * The same claim on the ROWS. Asserting only the board would leave "one
     * card" true of a build that still cut three tickets and happened to list
     * one of them — a filter hiding siblings looks identical from up here.
     */
    const rows = await prisma.kitchenTicket.findMany({
      where: { roundId: sent.data.id },
      include: { items: true },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.items).toHaveLength(4);
    // NEGATIVE — it belongs to no station, in the column and on the wire, and
    // the card names none.
    expect(rows[0]!.stationId).toBeNull();
    expect(cards[0]!.stationId).toBeNull();
    expect(cards[0]!).not.toHaveProperty('stationName');
    // ONE document number for the round, not one per station.
    expect(rows[0]!.ticketNumber).toMatch(/^KOT-\d+$/);
    expect(cards[0]!.ticketNumber).toBe(rows[0]!.ticketNumber);

    /*
     * POSITIVE CONTROL, and the assertion that makes the two negatives above
     * mean anything (D30): the links the old split routed on are STILL THERE,
     * three products across three DIFFERENT stations. Delete them and this
     * test would still pass while proving nothing.
     */
    const links = await prisma.productStationLink.findMany({
      where: { productId: { in: [productId, grillProductId, pastryProductId] } },
      select: { stationId: true },
    });
    expect(links).toHaveLength(3);
    expect(new Set(links.map((l) => l.stationId)).size).toBe(3);
  });

  it('puts a dish linked to NO station on the board — the defect D147 fixes', async () => {
    /*
     * Named, because it is the reason the split went rather than a side
     * effect of removing it: at a branch with more than one active station
     * the old routing put an item with no station link on NO ticket at all.
     * It was ordered, it was billed, and the kitchen never saw it.
     */
    const sent = await http.request<{ id: string }>(
      'POST',
      `/restaurant/orders/${orderId}/rounds`,
      {
        token: ownerToken(),
        body: {
          idempotencyKey: 'd143-unlinked',
          items: [{ sourceKind: 'PRODUCT', productId: unlinkedProductId, quantity: '3' }],
        },
      },
    );
    expect(sent.status).toBe(201);

    // POSITIVE — it reaches the pass, on its own card, with its quantity.
    const cards = (await board('?status=OUTSTANDING')).data;
    expect(cards).toHaveLength(1);
    expect(cards[0]!.items.map((i) => i.menuItemName)).toEqual(['Chicken Kottu']);
    expect(cards[0]!.items[0]!.quantity).toBe('3.000');
    expect(cards[0]!.stationId).toBeNull();
    // …and a row backs it, so "on the board" is not a projection artefact.
    expect(await prisma.kitchenTicket.count({ where: { roundId: sent.data.id } })).toBe(1);

    /*
     * The two preconditions, ASSERTED rather than assumed (D30). Without both
     * this test would stay green against the very routing it proves gone:
     *   • the dish genuinely has no station link, and
     *   • the branch has more than one active station, so the retired
     *     sole-station fallback could not have rescued it either.
     */
    expect(await prisma.productStationLink.count({ where: { productId: unlinkedProductId } })).toBe(
      0,
    );
    expect(await prisma.kitchenStation.count({ where: { branchId, isActive: true } })).toBe(4);
  });
});

describe('D68 — kitchen staff complete tickets', () => {
  it('completing moves the ticket off the outstanding board and records who', async () => {
    await sendRound();
    const ticketId = (await board()).data[0]!.id;

    const done = await http.request<TicketView>(
      'POST',
      `/restaurant/branches/${branchId}/kitchen-tickets/${ticketId}/complete`,
      { token: kitchenToken() },
    );
    expect(done.status).toBe(201);
    expect(done.data.status).toBe('COMPLETED');
    expect(done.data.completedByName).toBe('Chef Fixture');
    expect(done.data.completedAt).not.toBeNull();

    // POSITIVE + NEGATIVE on the same read: gone from one list, present in
    // the other. Asserting only its disappearance would also pass if the
    // ticket had been deleted.
    expect((await board('?status=OUTSTANDING')).data).toHaveLength(0);
    const completed = (await board('?status=COMPLETED')).data;
    expect(completed.map((t) => t.id)).toEqual([ticketId]);
  });

  it('completing twice does not rewrite who finished it', async () => {
    await sendRound();
    const ticketId = (await board()).data[0]!.id;
    const url = `/restaurant/branches/${branchId}/kitchen-tickets/${ticketId}/complete`;

    const first = await http.request<TicketView>('POST', url, { token: kitchenToken() });
    // The owner presses it again — a real double-tap on a shared screen.
    const second = await http.request<TicketView>('POST', url, { token: ownerToken() });

    expect(second.status).toBe(201);
    expect(second.data.completedByName).toBe('Chef Fixture');
    expect(second.data.completedAt).toBe(first.data.completedAt);
  });

  it('a ticket from another branch is 404, not silently completed', async () => {
    await sendRound();
    const ticketId = (await board()).data[0]!.id;
    const otherBranch = await prisma.branch.create({
      data: { tenantId: restaurant.tenantId, name: 'Second', code: 'SEC' },
    });

    const res = await http.request(
      'POST',
      `/restaurant/branches/${otherBranch.id}/kitchen-tickets/${ticketId}/complete`,
      { token: ownerToken() },
    );
    expect(res.status).toBe(404);

    // POSITIVE CONTROL — the ticket is untouched, so the 404 above is a
    // refusal rather than a write that also happened to error.
    const row = await prisma.kitchenTicket.findFirstOrThrow({ where: { id: ticketId } });
    expect({ status: row.status, completedBy: row.completedByUserId }).toEqual({
      status: 'QUEUED',
      completedBy: null,
    });
  });

  it('a pre-D68 ticket left on PRINTED still counts as outstanding', async () => {
    await sendRound();
    const ticketId = (await board()).data[0]!.id;
    // Simulate a row written before printing was withdrawn.
    await prisma.kitchenTicket.update({
      where: { id: ticketId },
      data: { status: 'PRINTED' },
    });

    const outstanding = (await board('?status=OUTSTANDING')).data;
    expect(outstanding.map((t) => t.id)).toEqual([ticketId]);
    // NEGATIVE — and it is not being counted as finished work.
    expect((await board('?status=COMPLETED')).data).toHaveLength(0);
  });
});

describe('D68 — the kitchen role reaches the board and nothing else', () => {
  it('kitchen staff can complete a ticket but cannot close the table or take payment', async () => {
    await sendRound();
    const ticketId = (await board()).data[0]!.id;

    // POSITIVE — the job they are rostered to.
    const done = await http.request(
      'POST',
      `/restaurant/branches/${branchId}/kitchen-tickets/${ticketId}/complete`,
      { token: kitchenToken() },
    );
    expect(done.status).toBe(201);

    // NEGATIVE — the till. Same user, same token: this pair is what proves
    // authority comes from the KITCHEN_STAFF row and not from the CASHIER
    // enum value in their JWT.
    const close = await http.request(
      'POST',
      `/restaurant/table-sessions/${sessionId}/close`,
      { token: kitchenToken(), body: { idempotencyKey: 'k1' } },
    );
    expect(close.status).toBe(403);

    const order = await http.request(
      'POST',
      `/restaurant/table-sessions/${sessionId}/orders`,
      { token: kitchenToken() },
    );
    expect(order.status).toBe(403);
  });
});

/**
 * D70 — a waiter sees the sessions THEY opened, and no others.
 *
 * ## Why every case is a pair
 *
 * "Waiter A cannot see Waiter B's table" passes trivially against a build
 * that returns nothing to anybody, so each refusal is asserted alongside the
 * same waiter succeeding on their OWN session, through the same endpoint, in
 * the same test. And each is asserted against a supervisor who still sees
 * both — a scope that hid the floor from the cashier would be a worse bug
 * than the one being fixed, and silent.
 */
describe('D70 — session visibility is scoped to the waiter', () => {
  let waiterA: string;
  let waiterB: string;
  let sessionA: string;
  let sessionB: string;
  let cashier: string;

  const tokenFor = (userId: string) =>
    http.tokenFor({
      userId,
      tenantId: restaurant.tenantId,
      role: 'CASHIER',
      activeBranchId: branchId,
    });

  beforeEach(async () => {
    const waiterRole = await prisma.role.findFirstOrThrow({
      where: { tenantId: restaurant.tenantId, key: 'WAITER' },
      select: { id: true },
    });
    const cashierRole = await prisma.role.findFirstOrThrow({
      where: { tenantId: restaurant.tenantId, key: 'RESTAURANT_CASHIER' },
      select: { id: true },
    });
    const mk = async (name: string, email: string, roleId: string) =>
      (
        await prisma.user.create({
          data: { tenantId: restaurant.tenantId, name, email, role: 'CASHIER', roleId, branchId },
        })
      ).id;
    waiterA = await mk('Waiter A', 'a@fixture.test', waiterRole.id);
    waiterB = await mk('Waiter B', 'b@fixture.test', waiterRole.id);
    cashier = await mk('Till', 'till@fixture.test', cashierRole.id);

    const area = await prisma.diningArea.create({
      data: { tenantId: restaurant.tenantId, branchId, name: 'Bar' },
    });
    const seat = async (code: string, waiterUserId: string) => {
      const table = await prisma.restaurantTable.create({
        data: { tenantId: restaurant.tenantId, branchId, areaId: area.id, code, capacity: 2 },
      });
      const res = await http.request<{ id: string }>(
        'POST',
        `/restaurant/branches/${branchId}/table-sessions`,
        { token: tokenFor(waiterUserId), body: { tableId: table.id, waiterUserId } },
      );
      expect(res.status).toBe(201);
      return res.data.id;
    };
    sessionA = await seat('B1', waiterA);
    sessionB = await seat('B2', waiterB);
  });

  it('lists only the caller\'s own open sessions', async () => {
    const forA = await http.request<{ id: string }[]>(
      'GET',
      `/restaurant/branches/${branchId}/open-sessions`,
      { token: tokenFor(waiterA) },
    );
    // POSITIVE — A's own table is there…
    expect(forA.data.map((s) => s.id)).toContain(sessionA);
    // …NEGATIVE — and B's is not.
    expect(forA.data.map((s) => s.id)).not.toContain(sessionB);

    // The mirror image, so this is a per-caller scope and not a filter that
    // happens to favour whoever asked first.
    const forB = await http.request<{ id: string }[]>(
      'GET',
      `/restaurant/branches/${branchId}/open-sessions`,
      { token: tokenFor(waiterB) },
    );
    expect(forB.data.map((s) => s.id)).toEqual([sessionB]);
  });

  it('still shows the whole floor to the cashier and the owner', async () => {
    for (const token of [tokenFor(cashier), ownerToken()]) {
      const res = await http.request<{ id: string }[]>(
        'GET',
        `/restaurant/branches/${branchId}/open-sessions`,
        { token },
      );
      const ids = res.data.map((s) => s.id);
      expect(ids).toContain(sessionA);
      expect(ids).toContain(sessionB);
    }
  });

  it('refuses to read another waiter\'s session by id, on every read route', async () => {
    for (const path of [
      `/restaurant/table-sessions/${sessionB}`,
      `/restaurant/table-sessions/${sessionB}/detail`,
    ]) {
      const mine = path.replace(sessionB, sessionA);
      // POSITIVE — the same route, the same token, A's own session: 200.
      expect((await http.request('GET', mine, { token: tokenFor(waiterA) })).status).toBe(200);
      // NEGATIVE — B's session: refused. 404 rather than 403, so the response
      // does not confirm that the session exists and belongs to someone else.
      expect((await http.request('GET', path, { token: tokenFor(waiterA) })).status).toBe(404);
    }
  });

  it('refuses to WRITE to another waiter\'s session — hiding it is not enough', async () => {
    // Ordering onto someone else's table, and closing it out from under them,
    // are the two writes reachable by guessing an id.
    expect(
      (
        await http.request('POST', `/restaurant/table-sessions/${sessionB}/orders`, {
          token: tokenFor(waiterA),
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await http.request('POST', `/restaurant/table-sessions/${sessionB}/close`, {
          token: tokenFor(waiterA),
          body: { idempotencyKey: 'x1' },
        })
      ).status,
    ).toBe(404);

    // POSITIVE CONTROL — A can do both on their own table, so the refusals
    // above are about ownership and not about the routes being broken.
    expect(
      (
        await http.request('POST', `/restaurant/table-sessions/${sessionA}/orders`, {
          token: tokenFor(waiterA),
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await http.request('POST', `/restaurant/table-sessions/${sessionA}/close`, {
          token: tokenFor(waiterA),
          body: { idempotencyKey: 'x2' },
        })
      ).status,
    ).toBe(200);
  });
});

/*
 * D113 — Preparing, and everything it moves.
 *
 * One flow, every direction asserted through the REAL routes: the start
 * puts the ticket on IN_PROGRESS (still outstanding — starting is not
 * bumping), the round follows, and the unified Orders feed says
 * IN_PROGRESS; the bump makes all three READY; the recall pulls all three
 * back down. The takeaway test proves the customer-facing profile advances
 * with the kitchen (PLACED → IN_KITCHEN → READY), retreats only from READY
 * on a recall, and never reaches HANDED_OVER without the cashier.
 */
describe('D113 — start/preparing ripples to the round and the Orders queue', () => {
  const unifiedFor = async (id: string) => {
    const res = await http.request<{ items: { id: string; unifiedStatus: string }[] }>(
      'GET',
      `/restaurant/branches/${branchId}/orders`,
      { token: ownerToken() },
    );
    return res.data.items.find((o) => o.id === id)?.unifiedStatus;
  };
  /** D114 — the counter-owned READY tally the queue's bell rings on. */
  const readyHandover = async () => {
    const res = await http.request<{ readyHandoverCount: number }>(
      'GET',
      `/restaurant/branches/${branchId}/orders`,
      { token: ownerToken() },
    );
    return res.data.readyHandoverCount;
  };
  const verb = (ticketId: string, action: 'start' | 'complete' | 'reopen') =>
    http.request<TicketView & { status: string }>(
      'POST',
      `/restaurant/branches/${branchId}/kitchen-tickets/${ticketId}/${action}`,
      { token: kitchenToken() },
    );

  it('start → IN_PROGRESS everywhere; bump → READY; recall → back to PENDING', async () => {
    await sendRound();
    const ticketId = (await board()).data[0]!.id;
    expect(await unifiedFor(orderId)).toBe('PENDING');

    const started = await verb(ticketId, 'start');
    expect(started.data.status).toBe('IN_PROGRESS');
    // Starting is not bumping: the ticket is still outstanding work…
    expect((await board('?status=OUTSTANDING')).data.map((t) => t.id)).toEqual([ticketId]);
    // …and the queue already says the kitchen is on it.
    expect(await unifiedFor(orderId)).toBe('IN_PROGRESS');

    await verb(ticketId, 'complete');
    expect(await unifiedFor(orderId)).toBe('READY');
    // D114's paired NEGATIVE: this is a DINE-IN order — ready, but the
    // counter's bell tally must not count it. The floor's bell owns it.
    expect(await readyHandover()).toBe(0);

    // Recall recomputes honestly: the only ticket is queued again, so the
    // order is plain pending — not stuck on a state the kitchen retracted.
    await verb(ticketId, 'reopen');
    expect(await unifiedFor(orderId)).toBe('PENDING');
  });

  it('start is idempotent, and a stale start never un-completes a bumped ticket', async () => {
    await sendRound();
    const ticketId = (await board()).data[0]!.id;

    await verb(ticketId, 'start');
    const again = await verb(ticketId, 'start');
    expect(again.data.status).toBe('IN_PROGRESS');

    await verb(ticketId, 'complete');
    const stale = await verb(ticketId, 'start');
    expect(stale.data.status).toBe('COMPLETED');
  });

  it('a takeaway order advances with the kitchen, and handover stays the cashier\'s', async () => {
    const created = await http.request<{ id: string; orderNumber: string; status: string }>(
      'POST',
      `/restaurant/takeaway`,
      {
        token: ownerToken(),
        body: {
          branchId,
          customerName: 'Pickup Fixture',
          idempotencyKey: 'd106-takeaway',
          items: [{ sourceKind: 'PRODUCT', productId, quantity: 1 }],
        },
      },
    );
    expect(created.data.status).toBe('PLACED');
    const takeawayTicket = (await board('?status=OUTSTANDING')).data.find(
      (t) => t.orderNumber === created.data.orderNumber,
    )!;

    const profileStatus = async () => {
      const res = await http.request<{ id: string; status: string }[]>(
        'GET',
        `/restaurant/takeaway?branchId=${branchId}`,
        { token: ownerToken() },
      );
      return res.data.find((p) => p.id === created.data.id)?.status;
    };

    await verb(takeawayTicket.id, 'start');
    expect(await profileStatus()).toBe('IN_KITCHEN');
    expect(await readyHandover()).toBe(0);

    await verb(takeawayTicket.id, 'complete');
    expect(await profileStatus()).toBe('READY');
    // D114's POSITIVE: a takeaway up on the pass is the counter's to hear.
    expect(await readyHandover()).toBe(1);

    // The recall retracts READY — "your food is ready" stopped being true —
    // but only down to IN_KITCHEN, never past what the customer was told.
    await verb(takeawayTicket.id, 'reopen');
    expect(await profileStatus()).toBe('IN_KITCHEN');
    expect(await readyHandover()).toBe(0);
  });
});

/*
 * D115 — cancellation reaches the pass. A cancelled takeaway used to keep
 * its ticket on the board and the kitchen kept cooking it; now the ticket
 * leaves the working lanes and turns up under the CANCELLED pseudo-filter.
 * Both directions at every step: present where it must be, absent where it
 * must not, with the pre-cancel reads as the positive controls.
 */
describe('D115 — cancelled work leaves the board and lands in its own lane', () => {
  const boardAs = (query: string) =>
    http.request<TicketView[]>(
      'GET',
      `/restaurant/branches/${branchId}/kitchen-tickets${query}`,
      { token: kitchenToken() },
    );

  const createTakeaway = async (key: string) => {
    const created = await http.request<{ id: string; orderNumber: string }>(
      'POST',
      `/restaurant/takeaway`,
      {
        token: ownerToken(),
        body: {
          branchId,
          idempotencyKey: key,
          items: [{ sourceKind: 'PRODUCT', productId, quantity: 1 }],
        },
      },
    );
    const t = (await boardAs('?status=OUTSTANDING')).data.find(
      (x) => x.orderNumber === created.data.orderNumber,
    )!;
    return { profileId: created.data.id, ticketId: t.id };
  };

  const cancel = (profileId: string) =>
    http.request('PATCH', `/restaurant/takeaway/${profileId}/status`, {
      token: ownerToken(),
      body: { status: 'CANCELLED' },
    });

  it('an outstanding ticket disappears from To make and appears under Cancelled', async () => {
    const { profileId, ticketId } = await createTakeaway('d108-a');
    // Positive control — on the board before the cancel, in no Cancelled lane.
    expect((await boardAs('?status=OUTSTANDING')).data.map((t) => t.id)).toContain(ticketId);
    expect((await boardAs('?status=CANCELLED')).data).toHaveLength(0);

    await cancel(profileId);

    expect((await boardAs('?status=OUTSTANDING')).data.map((t) => t.id)).not.toContain(ticketId);
    expect((await boardAs('?status=CANCELLED')).data.map((t) => t.id)).toEqual([ticketId]);
  });

  it('a completed ticket of a cancelled order leaves Done for Cancelled too', async () => {
    const { profileId, ticketId } = await createTakeaway('d108-b');
    await http.request(
      'POST',
      `/restaurant/branches/${branchId}/kitchen-tickets/${ticketId}/complete`,
      { token: kitchenToken() },
    );
    expect((await boardAs('?status=COMPLETED')).data.map((t) => t.id)).toContain(ticketId);

    await cancel(profileId);

    expect((await boardAs('?status=COMPLETED')).data.map((t) => t.id)).not.toContain(ticketId);
    expect((await boardAs('?status=CANCELLED')).data.map((t) => t.id)).toContain(ticketId);
  });
});

/*
 * D117 — money and handover are different instants. The counter settles at
 * payment time; the order must keep flowing the kitchen lifecycle and the
 * later handover must REUSE the settled Sale, never mint a second one.
 * Every step asserts the status the queue derives from, because the bug
 * this fixes was precisely a fresh order reading "Handed over".
 */
describe('D117 — settle creates the Sale without handing over', () => {
  it('settled order stays in the lifecycle; handover later reuses the same Sale', async () => {
    const created = await http.request<{ id: string; orderNumber: string; status: string }>(
      'POST',
      `/restaurant/takeaway`,
      {
        token: ownerToken(),
        body: {
          branchId,
          idempotencyKey: 'd110-settle',
          items: [{ sourceKind: 'PRODUCT', productId, quantity: 1 }],
        },
      },
    );
    expect(created.data.status).toBe('PLACED');

    const settled = await http.request<{ status: string; finalSaleId: string | null }>(
      'POST',
      `/restaurant/takeaway/${created.data.id}/settle`,
      { token: ownerToken() },
    );
    // The money exists…
    expect(settled.data.finalSaleId).not.toBeNull();
    // …and the lifecycle was NOT touched: the queue still says Pending.
    expect(settled.data.status).toBe('PLACED');

    // Idempotent: settling again returns the SAME Sale, not a second one.
    const again = await http.request<{ finalSaleId: string | null }>(
      'POST',
      `/restaurant/takeaway/${created.data.id}/settle`,
      { token: ownerToken() },
    );
    expect(again.data.finalSaleId).toBe(settled.data.finalSaleId);

    // The kitchen still drives a settled order: start → IN_KITCHEN, bump → READY.
    const t = (await board('?status=OUTSTANDING')).data.find(
      (x) => x.orderNumber === created.data.orderNumber,
    )!;
    await http.request(
      'POST',
      `/restaurant/branches/${branchId}/kitchen-tickets/${t.id}/start`,
      { token: kitchenToken() },
    );
    await http.request(
      'POST',
      `/restaurant/branches/${branchId}/kitchen-tickets/${t.id}/complete`,
      { token: kitchenToken() },
    );
    const rows = await http.request<{ id: string; status: string }[]>(
      'GET',
      `/restaurant/takeaway?branchId=${branchId}`,
      { token: ownerToken() },
    );
    expect(rows.data.find((r) => r.id === created.data.id)?.status).toBe('READY');

    // Handover is its own act — and it reuses the settled Sale.
    const handed = await http.request<{ status: string; finalSaleId: string | null }>(
      'PATCH',
      `/restaurant/takeaway/${created.data.id}/status`,
      { token: ownerToken(), body: { status: 'HANDED_OVER' } },
    );
    expect(handed.data.status).toBe('HANDED_OVER');
    expect(handed.data.finalSaleId).toBe(settled.data.finalSaleId);
  });

  it('a cancelled order refuses to settle', async () => {
    const created = await http.request<{ id: string }>('POST', `/restaurant/takeaway`, {
      token: ownerToken(),
      body: {
        branchId,
        idempotencyKey: 'd110-cancelled',
        items: [{ sourceKind: 'PRODUCT', productId, quantity: 1 }],
      },
    });
    await http.request('PATCH', `/restaurant/takeaway/${created.data.id}/status`, {
      token: ownerToken(),
      body: { status: 'CANCELLED' },
    });
    const res = await http.request('POST', `/restaurant/takeaway/${created.data.id}/settle`, {
      token: ownerToken(),
    });
    expect(res.status).toBe(400);
  });
});

/*
 * D112 — "food ready" reaches the floor through open-sessions, not KOT_VIEW.
 * The bump and the recall are exercised through the real kitchen routes so
 * the field tracks the ticket's actual lifecycle, and both directions are
 * asserted: silence before the bump, the id after it, silence again after
 * the recall — a field that always echoed every ticket id would fail twice.
 */
describe('D112 — open-sessions carries the session\'s bumped tickets', () => {
  const openSessions = () =>
    http.request<{ id: string; readyTicketIds: string[] }[]>(
      'GET',
      `/restaurant/branches/${branchId}/open-sessions`,
      { token: ownerToken() },
    );

  it('readyTicketIds is empty before the bump, the ticket id after, empty again on recall', async () => {
    await sendRound();
    const ticketId = (await board()).data[0]!.id;

    // NEGATIVE — queued food is not ready food.
    const before = (await openSessions()).data.find((s) => s.id === sessionId);
    expect(before?.readyTicketIds).toEqual([]);

    await http.request(
      'POST',
      `/restaurant/branches/${branchId}/kitchen-tickets/${ticketId}/complete`,
      { token: kitchenToken() },
    );
    // POSITIVE — the bump surfaces exactly this ticket on exactly this session.
    const after = (await openSessions()).data.find((s) => s.id === sessionId);
    expect(after?.readyTicketIds).toEqual([ticketId]);

    await http.request(
      'POST',
      `/restaurant/branches/${branchId}/kitchen-tickets/${ticketId}/reopen`,
      { token: kitchenToken() },
    );
    // NEGATIVE again — a recalled dish is work to do, not food to run.
    const recalled = (await openSessions()).data.find((s) => s.id === sessionId);
    expect(recalled?.readyTicketIds).toEqual([]);
  });
});

/*
 * D142 — the Done lane holds the shop's TODAY, and the history holds the rest.
 * D150 — and "the rest" means every lane, not only the finished one.
 *
 * The pairing is the point. A lane assertion alone would pass against a build
 * that had simply stopped returning old tickets anywhere, and a history
 * assertion alone would pass against one that had never scoped the lane: each
 * old ticket is asserted ABSENT from one list and PRESENT in the other, in the
 * same test, against the same row.
 *
 * D150 is proven against real rows for the same reason: the widened `where` is
 * a claim about which tickets Postgres returns, so the strongest form of it is
 * three tickets genuinely left queued, started and bumped — and a cancelled
 * one that must still not come back, tested in the QUEUED state where the old
 * `COMPLETED` filter was excluding it for free.
 */
describe('D142 — today on the board, everything in the history', () => {
  it('drops yesterday’s ticket from Done and keeps it in the history', async () => {
    await sendRound();
    const todayTicket = (await board('?status=OUTSTANDING')).data[0]!.id;
    await bump(todayTicket);

    await sendRound();
    const oldTicket = (await board('?status=OUTSTANDING')).data[0]!.id;
    await bump(oldTicket);
    await backdate(oldTicket, 3);

    const lane = (await board('?status=COMPLETED_TODAY')).data.map((t) => t.id);
    // POSITIVE: today's bump is on the lane…
    expect(lane).toContain(todayTicket);
    // …NEGATIVE: three days ago is not.
    expect(lane).not.toContain(oldTicket);

    // And the ticket still exists, in both of the places it should: the
    // unscoped COMPLETED list the KDS route and a bookmark still mean…
    const everCompleted = (await board('?status=COMPLETED')).data.map((t) => t.id);
    expect(everCompleted).toEqual(expect.arrayContaining([todayTicket, oldTicket]));
    // …and the history, which is what the screen reads.
    const past = (await history()).data;
    expect(past.items.map((t) => t.id)).toEqual(expect.arrayContaining([todayTicket, oldTicket]));
    // TODAY'S IS IN THE HISTORY TOO — the brief's own requirement, and the
    // thing a naive "history = older than today" split would break.
    expect(past.items.map((t) => t.id)).toContain(todayTicket);
    expect(past.total).toBe(2);
  });

  it('reads newest-finished first, and carries who bumped it', async () => {
    await sendRound();
    const first = (await board('?status=OUTSTANDING')).data[0]!.id;
    await bump(first);
    await backdate(first, 5);

    await sendRound();
    const second = (await board('?status=OUTSTANDING')).data[0]!.id;
    await bump(second);

    const items = (await history()).data.items;
    // Both are bumped, so this pins the FINISHED block of the D150 order:
    // newest-finished first, regardless of which was raised first. Where the
    // unfinished ones land relative to it is asserted in its own test below.
    expect(items.map((t) => t.id)).toEqual([second, first]);
    expect(items[0]!.completedByName).toBe('Chef Fixture');
    expect(items[0]!.completedAt).not.toBeNull();
    // The context a printed KOT used to carry, still on the row weeks later.
    expect(items[0]!.items[0]!.menuItemName).toBeTruthy();
    /*
     * D147 — this line asserted `stationName` was truthy, which is now false
     * by decision rather than by regression: a ticket belongs to no station to
     * name. Rewritten to the new truth, and to the context the history screen
     * actually has to carry — where the food went, and whose order it was.
     */
    expect(items[0]!).not.toHaveProperty('stationName');
    expect(items[0]!.stationId).toBeNull();
    expect(items[0]!.placeLabel).toBe('T7 · Terrace');
    expect(items[0]!.orderNumber).toMatch(/^RO-\d+$/);
  });

  it('pages, and the count is of the whole set rather than the page', async () => {
    const ticketIds: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      await sendRound();
      const id = (await board('?status=OUTSTANDING')).data[0]!.id;
      await bump(id);
      ticketIds.push(id);
    }
    /*
     * All three finished at the SAME instant — the shape a real kitchen makes
     * when it bumps a table's tickets together, and the one where an ordering
     * without a tiebreak is free to differ per query.
     *
     * Honest about what this proves: with three rows on a freshly seeded table
     * Postgres returns them in a stable order anyway, so removing the `id`
     * tiebreak does NOT turn this red — measured, not assumed. What is
     * asserted here is the paging arithmetic over duplicate keys; the TIEBREAK
     * itself is pinned where it can be pinned exactly, as the emitted
     * `orderBy`, in src/modules/kitchen/kitchen-history.spec.ts (removing it
     * fails that spec).
     */
    const sameInstant = new Date();
    await prisma.kitchenTicket.updateMany({
      where: { id: { in: ticketIds } },
      data: { completedAt: sameInstant },
    });

    const firstPage = await history('?page=1&pageSize=2');
    expect(firstPage.data.items).toHaveLength(2);
    expect(firstPage.data.total).toBe(3);
    expect(firstPage.data.page).toBe(1);
    expect(firstPage.data.pageSize).toBe(2);

    const secondPage = await history('?page=2&pageSize=2');
    expect(secondPage.data.items).toHaveLength(1);
    // NEGATIVE — the pages neither overlap nor drop a row.
    const ids = [...firstPage.data.items, ...secondPage.data.items].map((t) => t.id);
    expect(new Set(ids).size).toBe(3);
    expect([...ids].sort()).toEqual([...ticketIds].sort());
  });

  it('searches the ticket number and the dish, and narrows rather than empties', async () => {
    await sendRound();
    const ticketId = (await board('?status=OUTSTANDING')).data[0]!.id;
    const bumped = await bump(ticketId);
    const ticketNumber = bumped.data.ticketNumber;
    const dish = bumped.data.items[0]!.menuItemName;

    // POSITIVE, three ways in: its own number, a lower-case fragment of the
    // dish, and nothing at all.
    expect((await history(`?search=${encodeURIComponent(ticketNumber)}`)).data.total).toBe(1);
    const fragment = dish.slice(0, 4).toLowerCase();
    expect((await history(`?search=${encodeURIComponent(fragment)}`)).data.total).toBe(1);
    expect((await history()).data.total).toBe(1);
    // NEGATIVE — a term that matches nothing returns nothing, so the positives
    // above are not simply an unfiltered list.
    expect((await history('?search=zzzznotathing')).data.total).toBe(0);
  });

  it('leaves cancelled work out of both the lane and the history (D115)', async () => {
    await sendRound();
    const ticketId = (await board('?status=OUTSTANDING')).data[0]!.id;
    await bump(ticketId);
    // POSITIVE first, so the negatives below cannot pass on an empty branch.
    expect((await history()).data.items.map((t) => t.id)).toContain(ticketId);

    await prisma.restaurantOrder.update({
      where: { id: orderId },
      data: { status: 'CANCELLED' },
    });

    expect((await board('?status=COMPLETED_TODAY')).data.map((t) => t.id)).not.toContain(ticketId);
    expect((await history()).data.items.map((t) => t.id)).not.toContain(ticketId);
    // …and it is still findable where cancelled work belongs.
    expect((await board('?status=CANCELLED')).data.map((t) => t.id)).toContain(ticketId);
  });

  it('D150 — holds To make and Preparing as well, with the unfinished first', async () => {
    /*
     * THE DEFECT, against real rows: the history narrowed to COMPLETED, so a
     * ticket that was still queued or on the pass appeared on no row of the
     * screen at all. Three tickets, one in each lane the board draws, and all
     * three asserted present in the one list — with the board's own lanes read
     * beside them, so "all three are here" cannot pass against a build whose
     * lanes had themselves stopped splitting anything.
     */
    await sendRound();
    const queued = (await board('?status=OUTSTANDING')).data[0]!.id;
    await sendRound();
    const preparing = (await board('?status=OUTSTANDING')).data.find((t) => t.id !== queued)!.id;
    await http.request(
      'POST',
      `/restaurant/branches/${branchId}/kitchen-tickets/${preparing}/start`,
      { token: kitchenToken() },
    );
    await sendRound();
    const done = (await board('?status=OUTSTANDING')).data.find(
      (t) => t.id !== queued && t.id !== preparing,
    )!.id;
    await bump(done);

    /*
     * `createdAt` is a TIMESTAMP(3), so three rounds sent inside one
     * millisecond would tie and hand the pending pair's order to the id
     * tiebreak. Pushing the first one back an hour makes the assertion below
     * about the ORDERING rather than about how fast the machine ran — and it
     * leaves `done`, raised LAST of the three, as the newest row of all, so
     * "unfinished first" cannot be mistaken for "newest first".
     */
    await prisma.kitchenTicket.update({
      where: { id: queued },
      data: { createdAt: new Date(Date.now() - 60 * 60 * 1000) },
    });

    const page = (await history()).data;
    // POSITIVE — every lane in the one list, unfinished first (newest-raised
    // of the two leading), and the finished one last despite being newest.
    expect(page.items.map((t) => t.id)).toEqual([preparing, queued, done]);
    expect(page.total).toBe(3);

    // …each carrying what the table renders per row: the status it badges by,
    // and the nulls it prints as "—".
    const byId = new Map(page.items.map((t) => [t.id, t]));
    expect(byId.get(queued)!.status).toBe('QUEUED');
    expect(byId.get(preparing)!.status).toBe('IN_PROGRESS');
    expect(byId.get(done)!.status).toBe('COMPLETED');
    expect(byId.get(queued)!.completedAt).toBeNull();
    expect(byId.get(queued)!.completedByName).toBeNull();
    expect(byId.get(preparing)!.completedAt).toBeNull();
    expect(byId.get(done)!.completedAt).not.toBeNull();
    expect(byId.get(done)!.completedByName).toBe('Chef Fixture');
    // …and the context a pending row still has to carry, since this screen is
    // now where a stuck ticket gets chased from.
    expect(byId.get(queued)!.placeLabel).toBe('T7 · Terrace');
    expect(byId.get(queued)!.items[0]!.menuItemName).toBe('Beef Steak');

    /*
     * NEGATIVE — the BOARD still splits those same three tickets three ways.
     * Without this the test above would also pass for a build that had widened
     * the lanes as well, which is the one thing D142 says must not happen: the
     * history got wider, the lanes did not.
     */
    expect([...(await board('?status=OUTSTANDING')).data.map((t) => t.id)].sort()).toEqual(
      [queued, preparing].sort(),
    );
    expect((await board('?status=COMPLETED_TODAY')).data.map((t) => t.id)).toEqual([done]);
  });

  it('D115/D150 — cancelled work stays out even in the states D150 let in', async () => {
    /*
     * The exclusion this widening could most easily have broken. While the
     * history read `status: COMPLETED`, a queued ticket was kept out by the
     * STATUS clause whatever its round or order said; the cancellation clauses
     * were only ever load-bearing for bumped tickets. So both tickets here are
     * left QUEUED, which is the state where nothing else is keeping them out.
     */
    await sendRound();
    const kept = (await board('?status=OUTSTANDING')).data[0]!.id;
    await sendRound();
    const calledOff = (await board('?status=OUTSTANDING')).data.find((t) => t.id !== kept)!.id;

    // POSITIVE first — D150 puts both queued tickets in the history, so the
    // negatives below cannot pass on an empty branch, and cannot pass by the
    // old status filter quietly still doing the excluding.
    const before = (await history()).data;
    expect(before.items.map((t) => t.id)).toEqual(expect.arrayContaining([kept, calledOff]));
    expect(before.total).toBe(2);

    // One round is called off. No verb writes this today — D115's clause is
    // spelled at the level a future cancel will write, so the row is made by
    // hand, exactly as `backdate` makes yesterday.
    const { roundId } = await prisma.kitchenTicket.findUniqueOrThrow({
      where: { id: calledOff },
      select: { roundId: true },
    });
    await prisma.orderRound.update({ where: { id: roundId }, data: { status: 'CANCELLED' } });

    const afterRound = (await history()).data;
    // NEGATIVE, paired with the POSITIVE that its neighbour survived: this is
    // an exclusion and not an empty list.
    expect(afterRound.items.map((t) => t.id)).toContain(kept);
    expect(afterRound.items.map((t) => t.id)).not.toContain(calledOff);
    expect(afterRound.total).toBe(1);

    // And the order-level cancel takes the survivor with it.
    await prisma.restaurantOrder.update({
      where: { id: orderId },
      data: { status: 'CANCELLED' },
    });
    const afterOrder = (await history()).data;
    expect(afterOrder.items).toEqual([]);
    expect(afterOrder.total).toBe(0);

    // …and both are still findable where cancelled work belongs, so the zeroes
    // above are an exclusion from THIS list rather than a deletion.
    expect([...(await board('?status=CANCELLED')).data.map((t) => t.id)].sort()).toEqual(
      [kept, calledOff].sort(),
    );
  });

  it('is the kitchen’s to read — the same permission as the board', async () => {
    await sendRound();
    await bump((await board('?status=OUTSTANDING')).data[0]!.id);

    // POSITIVE — the kitchen-staff token, holding KOT_VIEW and nothing on the
    // floor, reads its own history.
    expect((await history()).status).toBe(200);

    /*
     * NEGATIVE on the SAME token — the file's own idiom. Without it the 200
     * above would also pass for a token that could do anything, which is
     * exactly what would happen if authority ever fell back to the JWT's enum
     * (these claims say CASHIER; the authority is the linked role ROW).
     */
    const floor = await http.request('POST', `/restaurant/table-sessions/${sessionId}/close`, {
      token: kitchenToken(),
    });
    expect(floor.status).toBe(403);

    /*
     * NEGATIVE on THIS ROUTE — the one that proves the gate is on the history
     * endpoint rather than merely somewhere in the module. A user linked to no
     * role row at all resolves through the legacy enum, which grants no
     * KOT_VIEW, so the same URL that answered 200 above must refuse them.
     */
    const stranger = await prisma.user.create({
      data: {
        tenantId: restaurant.tenantId,
        email: `no-kot-${Date.now()}@axlopos.test`,
        name: 'No Kitchen Permission',
        passwordHash: 'x',
        role: 'ACCOUNTANT',
        branchId,
      },
    });
    const refused = await http.request(
      'GET',
      `/restaurant/branches/${branchId}/kitchen-tickets/history`,
      {
        token: http.tokenFor({
          userId: stranger.id,
          tenantId: restaurant.tenantId,
          role: 'ACCOUNTANT',
          activeBranchId: branchId,
        }),
      },
    );
    expect(refused.status).toBe(403);
    // …and the board's own list refuses them identically, so the history is
    // gated exactly as the screen it relieves.
    const boardRefused = await http.request(
      'GET',
      `/restaurant/branches/${branchId}/kitchen-tickets`,
      {
        token: http.tokenFor({
          userId: stranger.id,
          tenantId: restaurant.tenantId,
          role: 'ACCOUNTANT',
          activeBranchId: branchId,
        }),
      },
    );
    expect(boardRefused.status).toBe(403);
  });
});

/*
 * D142b — the chips agree with the lanes.
 *
 * The board fetches one lane at a time and counts the other two from here, so
 * the only failure that matters is DRIFT: a chip promising work the list does
 * not have. Every count is therefore asserted against the LIST it labels, in
 * the same test, rather than against a number typed into the spec.
 */
describe('D142b — the lane counts', () => {
  it('matches each lane’s own list, across all three', async () => {
    // One queued, one started, one bumped — every lane non-empty, so no count
    // can pass by being zero.
    await sendRound();
    const queued = (await board('?status=OUTSTANDING')).data[0]!.id;
    await sendRound();
    const starting = (await board('?status=OUTSTANDING')).data.find((t) => t.id !== queued)!.id;
    await http.request(
      'POST',
      `/restaurant/branches/${branchId}/kitchen-tickets/${starting}/start`,
      { token: kitchenToken() },
    );
    await sendRound();
    const bumped = (await board('?status=OUTSTANDING')).data.find(
      (t) => t.id !== queued && t.id !== starting,
    )!.id;
    await bump(bumped);

    const outstanding = (await board('?status=OUTSTANDING')).data;
    const done = (await board('?status=COMPLETED_TODAY')).data;
    const counts = (await laneCounts()).data;

    expect(counts.toMake).toBe(outstanding.filter((t) => t.status !== 'IN_PROGRESS').length);
    expect(counts.preparing).toBe(outstanding.filter((t) => t.status === 'IN_PROGRESS').length);
    expect(counts.doneToday).toBe(done.length);
    // POSITIVE — and the numbers are the real ones, not three zeroes agreeing.
    expect(counts).toEqual({ toMake: 1, preparing: 1, doneToday: 1 });
  });

  it('counts the DAY on Done, like the lane does', async () => {
    await sendRound();
    const old = (await board('?status=OUTSTANDING')).data[0]!.id;
    await bump(old);
    expect((await laneCounts()).data.doneToday).toBe(1);

    await backdate(old, 3);

    // NEGATIVE — out of today's window, out of the count, exactly as it is out
    // of the lane. A count over every COMPLETED row would still say 1.
    expect((await laneCounts()).data.doneToday).toBe(0);
    expect((await board('?status=COMPLETED_TODAY')).data).toHaveLength(0);
    // …and it is still there unscoped, so the zero above is a window and not a
    // deletion.
    expect((await board('?status=COMPLETED')).data.map((t) => t.id)).toContain(old);
  });

  it('leaves cancelled work out of every count, like every lane (D115)', async () => {
    await sendRound();
    const ticketId = (await board('?status=OUTSTANDING')).data[0]!.id;
    expect((await laneCounts()).data.toMake).toBe(1);

    await prisma.restaurantOrder.update({
      where: { id: orderId },
      data: { status: 'CANCELLED' },
    });

    const counts = (await laneCounts()).data;
    expect(counts).toEqual({ toMake: 0, preparing: 0, doneToday: 0 });
    expect((await board('?status=CANCELLED')).data.map((t) => t.id)).toContain(ticketId);
  });

  it('is the kitchen’s to read, like the board', async () => {
    expect((await laneCounts()).status).toBe(200);

    const stranger = await prisma.user.create({
      data: {
        tenantId: restaurant.tenantId,
        email: `no-kot-counts-${Date.now()}@axlopos.test`,
        name: 'No Kitchen Permission',
        passwordHash: 'x',
        role: 'ACCOUNTANT',
        branchId,
      },
    });
    const refused = await http.request(
      'GET',
      `/restaurant/branches/${branchId}/kitchen-tickets/counts`,
      {
        token: http.tokenFor({
          userId: stranger.id,
          tenantId: restaurant.tenantId,
          role: 'ACCOUNTANT',
          activeBranchId: branchId,
        }),
      },
    );
    expect(refused.status).toBe(403);
  });
});
