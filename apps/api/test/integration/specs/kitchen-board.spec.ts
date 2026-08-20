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
  stationName: string;
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
    expect(ticket.stationName).toBe('Pass');
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
      select: { primaryPrinterId: true },
    });
    expect(stored.primaryPrinterId).toBeNull();
  });

  it('a second round is a second ticket, numbered as round 2', async () => {
    await sendRound();
    await sendRound();
    const res = await board();
    expect(res.data.map((t) => t.roundNumber).sort()).toEqual([1, 2]);
    // Oldest first: a kitchen works a queue.
    expect(res.data[0]!.roundNumber).toBe(1);
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
