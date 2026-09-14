/**
 * D178 — the waiter sends the bill; the till settles it; the table frees on
 * payment.
 *
 *   kitchen bumps → waiter "Proceed to pay" → session BILLING, table BILLING,
 *   served rounds DELIVERED, one Sale UNPAID → cashier records payment →
 *   on PAID: order COMPLETED, session CLOSED, table AVAILABLE.
 *
 * Before D178 the close did the release itself, in the same transaction that
 * raised the Sale, so a table showed free before a rupee moved. Every claim
 * below is paired per D30: the send is asserted to have raised the bill
 * (positive) AND to have moved nothing on the floor (negative); the partial
 * payment is asserted to have been recorded AND to have freed nothing; and
 * the hook is proven inert for the three shapes of sale that must not
 * trigger it — a pre-D178 close, a sale with no session, and a payment that
 * does not clear the balance.
 *
 * Permissions are asserted both ways on the same routes: the waiter can send
 * and cannot collect; the cashier can collect and cannot send. A guard that
 * refused everything would pass only half of each pair.
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
let tableId: string;
let itemId: string;
let waiterId: string;
let cashierId: string;
let kitchenId: string;

const tokenFor = (userId: string) =>
  http.tokenFor({
    userId,
    tenantId: restaurant.tenantId,
    // The enum value is deliberately NOT the authority — the linked role row
    // is (see kitchen-board.spec). Same claim on every token here.
    role: 'CASHIER',
    activeBranchId: branchId,
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

  const roleId = async (key: string) =>
    (
      await prisma.role.findFirstOrThrow({
        where: { tenantId: restaurant.tenantId, key },
        select: { id: true },
      })
    ).id;
  const mk = async (name: string, email: string, key: string) =>
    (
      await prisma.user.create({
        data: {
          tenantId: restaurant.tenantId,
          name,
          email,
          role: 'CASHIER',
          roleId: await roleId(key),
          branchId,
        },
      })
    ).id;
  waiterId = await mk('Floor', 'floor@fixture.test', 'WAITER');
  cashierId = await mk('Till', 'till@fixture.test', 'RESTAURANT_CASHIER');
  kitchenId = await mk('Pass', 'pass@fixture.test', 'KITCHEN_STAFF');

  const area = await prisma.diningArea.create({
    data: { tenantId: restaurant.tenantId, branchId, name: 'Main' },
  });
  tableId = (
    await prisma.restaurantTable.create({
      data: { tenantId: restaurant.tenantId, branchId, areaId: area.id, code: 'T1', capacity: 4 },
    })
  ).id;
  const menu = await prisma.menu.create({
    data: { tenantId: restaurant.tenantId, branchId, name: 'Menu' },
  });
  const section = await prisma.menuSection.create({
    data: { tenantId: restaurant.tenantId, menuId: menu.id, name: 'Mains' },
  });
  itemId = (
    await prisma.menuItem.create({
      data: { tenantId: restaurant.tenantId, sectionId: section.id, name: 'Kottu', basePrice: '12.50' },
    })
  ).id;
});

// ── helpers ─────────────────────────────────────────────────────────────────

/** Open the table as the waiter, raise one order and send one round. */
async function seatAndOrder(key = 'r1') {
  const session = await http.request<{ id: string }>(
    'POST',
    `/restaurant/branches/${branchId}/table-sessions`,
    { token: tokenFor(waiterId), body: { tableId, guestCount: 2, waiterUserId: waiterId } },
  );
  expect(session.status).toBe(201);
  const order = await http.request<{ id: string }>(
    'POST',
    `/restaurant/table-sessions/${session.data.id}/orders`,
    { token: tokenFor(waiterId) },
  );
  expect(order.status).toBe(201);
  const round = await http.request<{ id: string }>(
    'POST',
    `/restaurant/orders/${order.data.id}/rounds`,
    {
      token: tokenFor(waiterId),
      body: { idempotencyKey: key, items: [{ menuItemId: itemId, quantity: 2 }] },
    },
  );
  expect(round.status).toBe(201);
  return { sessionId: session.data.id, orderId: order.data.id, roundId: round.data.id };
}

async function ticketFor(roundId: string) {
  return prisma.kitchenTicket.findFirstOrThrow({ where: { roundId }, select: { id: true } });
}

const bump = (ticketId: string) =>
  http.request('POST', `/restaurant/branches/${branchId}/kitchen-tickets/${ticketId}/complete`, {
    token: tokenFor(kitchenId),
  });

const recall = (ticketId: string) =>
  http.request('POST', `/restaurant/branches/${branchId}/kitchen-tickets/${ticketId}/reopen`, {
    token: tokenFor(kitchenId),
  });

const sendToCashier = (sessionId: string, as = waiterId) =>
  http.request<{ session: { status: string; closedAt: string | null }; saleId: string }>(
    'POST',
    `/restaurant/table-sessions/${sessionId}/send-to-cashier`,
    { token: tokenFor(as), body: { idempotencyKey: `send-${sessionId}` } },
  );

const pay = (saleId: string, amount: number, as = cashierId) =>
  http.request<{ paymentStatus: string; balanceAmount: string }>(
    'POST',
    `/restaurant/bills/${saleId}/payments`,
    { token: tokenFor(as), body: { amount, method: 'CASH' } },
  );

const tableStatus = async () =>
  (await prisma.restaurantTable.findUniqueOrThrow({ where: { id: tableId } })).status;
const sessionRow = (id: string) => prisma.tableSession.findUniqueOrThrow({ where: { id } });
const roundStatus = async (id: string) =>
  (await prisma.orderRound.findUniqueOrThrow({ where: { id } })).status;
const orderRow = (id: string) => prisma.restaurantOrder.findUniqueOrThrow({ where: { id } });

/** The unified queue row for an order, as the Orders screen reads it. */
async function queueRow(orderId: string, as = cashierId, status?: string) {
  const page = await http.request<{
    items: Array<{
      id: string;
      unifiedStatus: string;
      sessionId: string | null;
      saleId: string | null;
      rounds: { roundNumber: number; status: string; items: { name: string; qty: number }[] }[];
    }>;
    statusCounts: Record<string, number>;
  }>('GET', `/restaurant/branches/${branchId}/orders?scope=all${status ? `&status=${status}` : ''}`, {
    token: tokenFor(as),
  });
  expect(page.status).toBe(200);
  const row = page.data.items.find((r) => r.id === orderId);
  if (!row) throw new Error(`order ${orderId} not on the queue`);
  return { row, counts: page.data.statusCounts };
}
/** Whether the queue lists the order at all under a status filter (D179 buckets). */
async function queued(orderId: string, status: string, as = cashierId) {
  const page = await http.request<{ items: Array<{ id: string }> }>(
    'GET',
    `/restaurant/branches/${branchId}/orders?scope=all&status=${status}`,
    { token: tokenFor(as) },
  );
  expect(page.status).toBe(200);
  return page.data.items.some((r) => r.id === orderId);
}

// ── the flow ────────────────────────────────────────────────────────────────

describe('D178 — proceed to pay, then settle', () => {
  it('holds the table from "Proceed to pay" until the bill is paid, then frees it', async () => {
    const { sessionId, orderId, roundId } = await seatAndOrder();
    expect(await tableStatus()).toBe('OCCUPIED');
    expect((await bump((await ticketFor(roundId)).id)).status).toBe(201);
    expect(await roundStatus(roundId)).toBe('READY');
    // D178a — the row carries the round and where the kitchen has it.
    const ready = await queueRow(orderId);
    expect(ready.row.rounds).toEqual([
      { roundNumber: 1, status: 'READY', items: [{ name: 'Kottu', qty: 2 }] },
    ]);

    // ── the waiter sends the bill ──
    const sent = await sendToCashier(sessionId);
    expect(sent.status).toBe(200);
    expect(sent.data.saleId).toBeTruthy();

    // POSITIVE — the bill exists, unpaid, and the served round is recorded.
    const sale = await prisma.sale.findUniqueOrThrow({ where: { id: sent.data.saleId } });
    expect(sale.paymentStatus).toBe('UNPAID');
    expect(sale.status).toBe('COMPLETED'); // D52 — unchanged by D178
    expect(sale.total.toFixed(2)).toBe('25.00');
    expect(await roundStatus(roundId)).toBe('DELIVERED');
    expect(
      await prisma.restaurantOrderItem.count({ where: { roundId, status: 'DELIVERED' } }),
    ).toBe(1);

    // NEGATIVE — nothing on the floor has been freed. This is the whole record.
    expect(sent.data.session.status).toBe('BILLING');
    expect(sent.data.session.closedAt).toBeNull();
    expect(await tableStatus()).toBe('BILLING');
    expect((await orderRow(orderId)).status).toBe('SUBMITTED');

    // …and the queue says where it is: To pay, addressed by session AND sale.
    const atTill = await queueRow(orderId);
    expect(atTill.row.unifiedStatus).toBe('AWAITING_PAYMENT');
    expect(atTill.row.sessionId).toBe(sessionId);
    expect(atTill.row.saleId).toBe(sale.id);
    expect(atTill.counts.AWAITING_PAYMENT).toBe(1);
    expect(atTill.row.rounds[0]!.status).toBe('DELIVERED');
    // D178 — the To pay filter is honoured server-side (it fell back to ALL
    // until the controller's allow-list learned the value).
    expect(await queued(orderId, 'AWAITING_PAYMENT')).toBe(true);
    expect(await queued(orderId, 'READY')).toBe(false);

    // ── a partial payment settles nothing ──
    const part = await pay(sale.id, 10);
    expect(part.status).toBe(201);
    expect(part.data.paymentStatus).toBe('PARTIAL');
    expect((await sessionRow(sessionId)).status).toBe('BILLING');
    expect(await tableStatus()).toBe('BILLING');
    expect((await orderRow(orderId)).status).toBe('SUBMITTED');

    // ── the payment that clears the balance is the one that ends it ──
    const rest = await pay(sale.id, 15);
    expect(rest.status).toBe(201);
    expect(rest.data.paymentStatus).toBe('PAID');
    expect(rest.data.balanceAmount).toBe('0.00');

    const closed = await sessionRow(sessionId);
    expect(closed.status).toBe('CLOSED');
    expect(closed.closedAt).not.toBeNull();
    expect(await tableStatus()).toBe('AVAILABLE');
    expect((await orderRow(orderId)).status).toBe('COMPLETED');
    const history = await prisma.restaurantOrderStatusHistory.findMany({
      where: { orderId },
      orderBy: { createdAt: 'asc' },
    });
    expect(history.map((h) => h.toStatus)).toEqual(['SUBMITTED', 'COMPLETED']);
    expect(history[1]!.changedByUserId).toBe(cashierId);
    expect((await queueRow(orderId)).row.unifiedStatus).toBe('COMPLETED');
    // D179 — finished, so it leaves the live queue and joins Completed; a
    // bare list (no status) still carries it, as the row above just proved.
    expect(await queued(orderId, 'OUTSTANDING')).toBe(false);
    expect(await queued(orderId, 'DONE')).toBe(true);
  });

  it('is idempotent: a second send answers with the same bill and raises no second Sale', async () => {
    const { sessionId } = await seatAndOrder();
    const first = await sendToCashier(sessionId);
    const again = await sendToCashier(sessionId);
    expect(again.status).toBe(200);
    expect(again.data.saleId).toBe(first.data.saleId);
    expect(again.data.session.status).toBe('BILLING');
    expect(
      await prisma.sale.count({ where: { sourceRefKind: 'TABLE_SESSION', sourceRefId: sessionId } }),
    ).toBe(1);
  });

  it('a kitchen recall cannot drag a served round back', async () => {
    const { sessionId, roundId } = await seatAndOrder();
    const ticket = await ticketFor(roundId);
    await bump(ticket.id);
    await sendToCashier(sessionId);
    expect(await roundStatus(roundId)).toBe('DELIVERED');

    // POSITIVE CONTROL — the recall itself works (the ticket moves)…
    expect((await recall(ticket.id)).status).toBe(201);
    expect(
      (await prisma.kitchenTicket.findUniqueOrThrow({ where: { id: ticket.id } })).status,
    ).toBe('QUEUED');
    // …NEGATIVE — and the round it belonged to does not follow it. DELIVERED
    // is outside the kitchen's KITCHEN_OWNED set (D113), which is the point.
    expect(await roundStatus(roundId)).toBe('DELIVERED');
  });

  it('leaves a round the kitchen has not bumped to the kitchen', async () => {
    const { sessionId, roundId } = await seatAndOrder();
    const sent = await sendToCashier(sessionId);
    expect(sent.status).toBe(200);
    // Not served — nobody has called it up. The kitchen still owns it, and
    // its later bump lands as READY exactly as it would on an open table.
    expect(await roundStatus(roundId)).toBe('SUBMITTED');
    await bump((await ticketFor(roundId)).id);
    expect(await roundStatus(roundId)).toBe('READY');
  });

  it('a table with nothing on it settles on the spot — a zero bill has nothing for the till to do', async () => {
    // A party that walked out before ordering. The Sale is raised at 0.00 (as
    // the close always did) and no payment can ever land on it, so a table
    // held "until paid" would be held forever. Found on the live stack.
    const session = await http.request<{ id: string }>(
      'POST',
      `/restaurant/branches/${branchId}/table-sessions`,
      { token: tokenFor(waiterId), body: { tableId, guestCount: 2, waiterUserId: waiterId } },
    );
    const order = await http.request<{ id: string }>(
      'POST',
      `/restaurant/table-sessions/${session.data.id}/orders`,
      { token: tokenFor(waiterId) },
    );
    expect(order.status).toBe(201);

    const sent = await sendToCashier(session.data.id);
    expect(sent.status).toBe(200);
    const sale = await prisma.sale.findUniqueOrThrow({ where: { id: sent.data.saleId } });
    expect(sale.total.toFixed(2)).toBe('0.00');
    // POSITIVE — settled through the same path the paying cashier takes.
    expect(sent.data.session.status).toBe('CLOSED');
    expect(sent.data.session.closedAt).not.toBeNull();
    expect(await tableStatus()).toBe('AVAILABLE');
    expect((await orderRow(order.data.id)).status).toBe('COMPLETED');
  });

  it('a table at the till is still live: listed on the floor, not re-seatable, not orderable', async () => {
    const { sessionId } = await seatAndOrder();
    await sendToCashier(sessionId);

    // POSITIVE — the floor still shows it (it used to vanish on close).
    const open = await http.request<{ id: string; status: string }[]>(
      'GET',
      `/restaurant/branches/${branchId}/open-sessions`,
      { token: tokenFor(waiterId) },
    );
    expect(open.data.map((s) => [s.id, s.status])).toEqual([[sessionId, 'BILLING']]);

    // NEGATIVE — nobody else can be sat there, and no more can be ordered on it.
    const reseat = await http.request(
      'POST',
      `/restaurant/branches/${branchId}/table-sessions`,
      { token: tokenFor(waiterId), body: { tableId, guestCount: 2 } },
    );
    expect(reseat.status).toBe(409);
    const more = await http.request(
      'POST',
      `/restaurant/table-sessions/${sessionId}/orders`,
      { token: tokenFor(waiterId) },
    );
    expect(more.status).toBe(400);
  });
});

describe('D178 — the payment hook is inert where it must be', () => {
  it('takes a payment on a pre-D178 bill (session already CLOSED) without touching the table', async () => {
    const { sessionId, orderId } = await seatAndOrder();
    const sent = await sendToCashier(sessionId);
    // Rewind to the shape every sale closed before D178 has: session CLOSED,
    // table already AVAILABLE, order never COMPLETED.
    await prisma.tableSession.update({
      where: { id: sessionId },
      data: { status: 'CLOSED', closedAt: new Date() },
    });
    await prisma.restaurantTable.update({ where: { id: tableId }, data: { status: 'AVAILABLE' } });
    // …and seat the NEXT party, which is what makes a stray release dangerous.
    const next = await http.request<{ id: string }>(
      'POST',
      `/restaurant/branches/${branchId}/table-sessions`,
      { token: tokenFor(waiterId), body: { tableId, guestCount: 2 } },
    );
    expect(next.status).toBe(201);
    expect(await tableStatus()).toBe('SEATED');

    const paid = await pay(sent.data.saleId, 25);
    expect(paid.status).toBe(201);
    expect(paid.data.paymentStatus).toBe('PAID');
    // NEGATIVE — the money landed and nothing else moved.
    expect(await tableStatus()).toBe('SEATED');
    expect((await sessionRow(next.data.id)).status).toBe('OPEN');
    expect((await orderRow(orderId)).status).toBe('SUBMITTED');
  });

  it('takes a payment on a sale with no table session at all', async () => {
    const sale = await prisma.sale.create({
      data: {
        tenantId: restaurant.tenantId,
        branchId,
        registerId: restaurant.registerId,
        cashierId: restaurant.cashierId,
        saleNumber: 'S-COUNTER-1',
        subtotal: '10.00',
        total: '10.00',
        paidAmount: 0,
        balanceAmount: '10.00',
        paymentStatus: 'UNPAID',
        status: 'COMPLETED',
        completedAt: new Date(),
        channel: 'COUNTER',
      },
      select: { id: true },
    });
    const paid = await pay(sale.id, 10);
    expect(paid.status).toBe(201);
    expect(paid.data.paymentStatus).toBe('PAID');
  });
});

describe('D178 — who may do which half', () => {
  it('the waiter sends and cannot collect; the cashier collects and cannot send', async () => {
    const { sessionId } = await seatAndOrder();

    // NEGATIVE — the till has no TABLE_CLOSE.
    expect((await sendToCashier(sessionId, cashierId)).status).toBe(403);
    // POSITIVE — the floor does.
    const sent = await sendToCashier(sessionId, waiterId);
    expect(sent.status).toBe(200);

    // NEGATIVE — the floor has no PAYMENT_COLLECT (D71, D87).
    expect((await pay(sent.data.saleId, 25, waiterId)).status).toBe(403);
    expect(await tableStatus()).toBe('BILLING');
    // POSITIVE — the till does, and that is what frees the table.
    expect((await pay(sent.data.saleId, 25, cashierId)).status).toBe(201);
    expect(await tableStatus()).toBe('AVAILABLE');
  });
});
