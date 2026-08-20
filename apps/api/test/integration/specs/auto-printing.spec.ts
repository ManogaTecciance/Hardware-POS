/**
 * D67 — auto-printing, end to end (PO request, 2026-08-18).
 *
 * The behaviour under test, in the user's words: items confirmed onto an
 * order are pushed to the kitchen and print there immediately; closing the
 * order prints the finalised bill on the cashier printer.
 *
 * D30 in both directions:
 *  - POSITIVE: a round queues KOT work for the resolved printer and the
 *    dispatcher prints it; closing queues and prints the bill; the printed
 *    bytes contain the real item and the real total.
 *  - NEGATIVE: nothing is queued for a branch that switched auto-print off;
 *    nothing is queued when no cashier printer is configured (the browser
 *    path still owns that case); a branch served by a live agent is left
 *    alone by the server-side dispatcher; and a failing printer marks the
 *    ticket FAILED without ever touching the order.
 */
import { readFileSync, readdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  seedTenantRoles,
  syncPermissionCatalogue,
  linkUsersToRoles,
} from '@hardware-pos/database';
import type { PrismaClient } from '@hardware-pos/database';

import { connectTestPrisma, disconnectTestPrisma } from '../prisma-test-client';
import { resetDatabase } from '../db-reset';
import { seedTenant, type SeededTenant } from '../fixtures';
import { createHttpIntegrationApp, type HttpIntegrationApp } from '../http-test-app';

const SPOOL_DIR = process.env.PRINT_MOCK_SPOOL_DIR ?? resolve(process.cwd(), '.print-spool');

let prisma: PrismaClient;
let http: HttpIntegrationApp;
let restaurant: SeededTenant;
let branchId: string;
let sessionId: string;
let orderId: string;
let beerId: string;
let stationId: string;
let kitchenPrinterId: string;
let cashierPrinterId: string;

const ownerToken = () =>
  http.tokenFor({
    userId: restaurant.ownerId,
    tenantId: restaurant.tenantId,
    role: 'OWNER',
    activeBranchId: restaurant.branchId,
  });

/** Everything the MOCK driver has spooled, as text. */
function spooled(): string[] {
  try {
    return readdirSync(SPOOL_DIR)
      .filter((f) => f.endsWith('.bin'))
      .map((f) => readFileSync(resolve(SPOOL_DIR, f), 'latin1'));
  } catch {
    return [];
  }
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
  rmSync(SPOOL_DIR, { recursive: true, force: true });
  await resetDatabase(prisma);
  restaurant = await seedTenant(prisma, {
    prefix: 'print',
    name: 'Fixture Restaurant',
    slug: 'fixture-print',
  });
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

  beerId = (
    await prisma.product.create({
      data: {
        tenantId: restaurant.tenantId,
        name: 'Bottled Beer',
        type: 'Inventory',
        sku: 'P-BEER',
        unitPrice: '400.00',
        quantityOnHand: '50',
        isActive: true,
      },
    })
  ).id;

  // A station the product routes to, and two MOCK printers (the driver
  // spools to disk, so "did it print?" is answerable without hardware).
  const station = await prisma.kitchenStation.create({
    data: { tenantId: restaurant.tenantId, branchId, code: 'GRILL', name: 'Grill' },
  });
  stationId = station.id;
  await prisma.productStationLink.create({ data: { productId: beerId, stationId } });

  kitchenPrinterId = (
    await prisma.kitchenPrinter.create({
      data: {
        tenantId: restaurant.tenantId,
        branchId,
        code: 'KIT',
        name: 'Kitchen printer',
        kind: 'MOCK',
        address: '',
        role: 'KITCHEN',
      },
    })
  ).id;
  cashierPrinterId = (
    await prisma.kitchenPrinter.create({
      data: {
        tenantId: restaurant.tenantId,
        branchId,
        code: 'CASH',
        name: 'Cashier printer',
        kind: 'MOCK',
        address: '',
        role: 'CASHIER',
      },
    })
  ).id;
  await prisma.kitchenStationPrinter.create({
    data: { stationId, printerId: kitchenPrinterId, isPrimary: true },
  });
  await prisma.restaurantBranchConfig.create({
    data: {
      tenantId: restaurant.tenantId,
      branchId,
      defaultReceiptPrinterId: cashierPrinterId,
      defaultKitchenPrinterId: kitchenPrinterId,
      // The takeaway cases below need the channel enabled on the branch.
      takeawayEnabled: true,
    },
  });

  const area = await prisma.diningArea.create({
    data: { tenantId: restaurant.tenantId, branchId, name: 'Main' },
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
});

const sendRound = (key: string, quantity = 2) =>
  http.request<{ id: string }>('POST', `/restaurant/orders/${orderId}/rounds`, {
    token: ownerToken(),
    body: {
      idempotencyKey: key,
      items: [{ sourceKind: 'PRODUCT', productId: beerId, quantity }],
    },
  });

/**
 * Nudge the dispatcher and wait for the queue to settle.
 *
 * Submitting a round already kicks a drain after commit (that is the whole
 * point — the ticket prints within a moment of the waiter tapping Send), so
 * a test cannot assert on the drain's own return value: the work may already
 * be done, or in flight. It asserts the OUTCOME instead, polling briefly.
 * The interval worker is disabled here, so the only drivers are that kick
 * and this explicit call.
 */
const drain = () =>
  http.request<{ kot: number; bill: number }>('POST', '/printing/drain', { token: ownerToken() });

async function waitFor(check: () => Promise<boolean>, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await drain();
    if (await check()) return;
    if (Date.now() > deadline) return;
    await new Promise((r) => setTimeout(r, 100));
  }
}

const closeSession = () =>
  http.request<{ saleId: string }>('POST', `/restaurant/table-sessions/${sessionId}/close`, {
    token: ownerToken(),
    body: { idempotencyKey: `close-${sessionId}` },
  });

describe('kitchen tickets print when the order is sent', () => {
  it('a submitted round queues an attempt and prints the ticket', async () => {
    expect((await sendRound('r1')).status).toBe(201);

    const queued = await prisma.kitchenPrintAttempt.findMany({
      where: { tenantId: restaurant.tenantId },
      include: { ticket: true },
    });
    expect(queued).toHaveLength(1);
    expect(queued[0].printerId).toBe(kitchenPrinterId);
    expect(queued[0].ticket.status).toBe('QUEUED');

    await waitFor(async () => spooled().length > 0);

    const printed = spooled();
    expect(printed).toHaveLength(1);
    expect(printed[0]).toContain('GRILL');
    expect(printed[0]).toContain('Bottled Beer');
    // Quantity is on the ticket, trimmed for the line cook.
    expect(printed[0]).toContain('2x');

    const ticket = await prisma.kitchenTicket.findFirstOrThrow({
      where: { tenantId: restaurant.tenantId },
    });
    expect(ticket.status).toBe('PRINTED');
  });

  it('a branch with auto-KOT off leaves the ticket queued for manual printing', async () => {
    await prisma.restaurantBranchConfig.update({
      where: { branchId },
      data: { autoPrintKot: false },
    });
    expect((await sendRound('r2')).status).toBe(201);

    await drain();
    expect(spooled()).toHaveLength(0);
    // The rows still exist — the KDS can print them by hand.
    expect(
      await prisma.kitchenPrintAttempt.count({
        where: { tenantId: restaurant.tenantId, status: 'PENDING' },
      }),
    ).toBe(1);
  });

  it('a failing printer marks the ticket FAILED and never touches the order', async () => {
    // An address nothing answers on: the driver reports a real socket error.
    await prisma.kitchenPrinter.update({
      where: { id: kitchenPrinterId },
      data: { kind: 'ESC_POS_NETWORK', address: '127.0.0.1:9' },
    });
    expect((await sendRound('r3')).status).toBe(201);

    // Three attempts, then the ticket gives up. `waitFor` keeps nudging:
    // a drain that overlaps the post-commit kick returns early by design.
    await waitFor(async () => {
      const t = await prisma.kitchenTicket.findFirst({ where: { tenantId: restaurant.tenantId } });
      return t?.status === 'FAILED';
    });

    const ticket = await prisma.kitchenTicket.findFirstOrThrow({
      where: { tenantId: restaurant.tenantId },
    });
    expect(ticket.status).toBe('FAILED');
    const failed = await prisma.kitchenPrintAttempt.findMany({
      where: { tenantId: restaurant.tenantId, status: 'FAILED' },
    });
    expect(failed.length).toBeGreaterThanOrEqual(1);
    expect(failed[0].error).toBeTruthy();
    // The ORDER is untouched — printing can never lose an order (D53).
    expect(
      await prisma.restaurantOrderItem.count({ where: { tenantId: restaurant.tenantId } }),
    ).toBe(1);
  });
});

describe('the bill prints when the waiter closes the order', () => {
  it('closing queues a bill job for the cashier printer and prints it', async () => {
    await sendRound('r4');
    await drain();

    const closed = await closeSession();
    expect(closed.status).toBe(200);

    const job = await prisma.printJob.findFirstOrThrow({
      where: { tenantId: restaurant.tenantId, type: 'ORDER_BILL' },
    });
    expect(job.printerId).toBe(cashierPrinterId);
    expect(job.saleId).toBe(closed.data.saleId);

    await waitFor(async () => spooled().some((doc) => doc.includes('TOTAL')));

    // The bill's bytes carry the real document: line, total, currency.
    const bill = spooled().find((doc) => doc.includes('TOTAL'));
    expect(bill).toBeTruthy();
    expect(bill).toContain('Bottled Beer');
    expect(bill).toContain('800.00');

    expect(
      (await prisma.printJob.findUniqueOrThrow({ where: { id: job.id } })).status,
    ).toBe('PRINTED');
  });

  it('queues NOTHING when the branch has no cashier printer, or auto-bill is off', async () => {
    await prisma.restaurantBranchConfig.update({
      where: { branchId },
      data: { defaultReceiptPrinterId: null },
    });
    await sendRound('r5');
    await closeSession();
    expect(
      await prisma.printJob.count({ where: { tenantId: restaurant.tenantId, type: 'ORDER_BILL' } }),
    ).toBe(0);
  });

  it('a per-user cashier printer beats the branch default', async () => {
    const personal = await prisma.kitchenPrinter.create({
      data: {
        tenantId: restaurant.tenantId,
        branchId,
        code: 'MINE',
        name: 'My printer',
        kind: 'MOCK',
        address: '',
        role: 'CASHIER',
      },
    });
    await prisma.userPrinterPreference.create({
      data: {
        tenantId: restaurant.tenantId,
        userId: restaurant.ownerId,
        cashierPrinterId: personal.id,
      },
    });

    await sendRound('r6');
    await closeSession();

    const job = await prisma.printJob.findFirstOrThrow({
      where: { tenantId: restaurant.tenantId, type: 'ORDER_BILL' },
    });
    expect(job.printerId).toBe(personal.id);
  });
});

describe('takeaway: the cashier takes the order, so BOTH print at placement', () => {
  it('placing a takeaway queues and prints the kitchen ticket AND the bill', async () => {
    const res = await http.request<{ orderId: string }>('POST', '/restaurant/takeaway', {
      token: ownerToken(),
      body: {
        branchId,
        idempotencyKey: 'takeaway-print-1',
        items: [{ sourceKind: 'PRODUCT', productId: beerId, quantity: 3 }],
      },
    });
    expect(res.status).toBe(201);

    // The bill job exists BEFORE any Sale does — it points at the order.
    const job = await prisma.printJob.findFirstOrThrow({
      where: { tenantId: restaurant.tenantId, type: 'ORDER_BILL' },
    });
    expect(job.saleId).toBeNull();
    expect(job.orderId).toBeTruthy();
    expect(job.printerId).toBe(cashierPrinterId);

    await waitFor(async () => {
      const docs = spooled();
      return docs.some((d) => d.includes('GRILL')) && docs.some((d) => d.includes('TOTAL'));
    });

    const docs = spooled();
    const ticket = docs.find((d) => d.includes('GRILL'));
    const bill = docs.find((d) => d.includes('TOTAL'));
    expect(ticket).toContain('Bottled Beer');
    expect(ticket).toContain('Takeaway');
    // 3 × 400.00, priced by the shared calculator — not recomputed here.
    expect(bill).toContain('1200.00');
    // Not settled yet, so the paper says so rather than implying payment.
    expect(bill).toContain('BALANCE DUE');
  });

  it('handing the order over does NOT print a second bill', async () => {
    const created = await http.request<{ id: string }>('POST', '/restaurant/takeaway', {
      token: ownerToken(),
      body: {
        branchId,
        idempotencyKey: 'takeaway-print-2',
        items: [{ sourceKind: 'PRODUCT', productId: beerId, quantity: 1 }],
      },
    });
    await waitFor(async () => spooled().some((d) => d.includes('TOTAL')));

    const handover = await http.request(
      'PATCH',
      `/restaurant/takeaway/${created.data.id}/status`,
      { token: ownerToken(), body: { status: 'HANDED_OVER' } },
    );
    expect(handover.status).toBe(200);
    await waitFor(async () => false, 500);

    // Exactly one bill job for this order — the customer gets one bill.
    expect(
      await prisma.printJob.count({
        where: { tenantId: restaurant.tenantId, type: 'ORDER_BILL' },
      }),
    ).toBe(1);
    expect(spooled().filter((d) => d.includes('TOTAL'))).toHaveLength(1);
  });
});

describe('transport: an on-site agent takes over from the server', () => {
  it('the server dispatcher leaves a branch with a LIVE agent alone', async () => {
    await prisma.printAgent.create({
      data: {
        tenantId: restaurant.tenantId,
        branchId,
        name: 'Shop PC',
        tokenHash: 'hash-live',
        lastSeenAt: new Date(),
      },
    });
    await sendRound('r7');

    await drain();
    expect(spooled()).toHaveLength(0);
    // Still queued — waiting for the agent to lease it, not lost.
    expect(
      await prisma.kitchenPrintAttempt.count({
        where: { tenantId: restaurant.tenantId, status: 'PENDING' },
      }),
    ).toBe(1);
  });

  it('a STALE agent does not block the server — the queue drains as normal', async () => {
    await prisma.printAgent.create({
      data: {
        tenantId: restaurant.tenantId,
        branchId,
        name: 'Dead PC',
        tokenHash: 'hash-stale',
        lastSeenAt: new Date(Date.now() - 10 * 60_000),
      },
    });
    await sendRound('r8');

    await waitFor(async () => spooled().length > 0);
    expect(spooled()).toHaveLength(1);
  });
});
