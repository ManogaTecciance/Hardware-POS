/**
 * D174 — unattended printing, end to end, as a COPY of the kitchen board.
 *
 * The behaviour under test, in the request's words: when a cashier, a waiter
 * or an owner sends an order to the kitchen, the kitchen's own printer
 * produces the ticket with nobody pressing anything; closing the order prints
 * the finalised bill on the cashier printer.
 *
 * D30 in both directions:
 *  - POSITIVE: a round queues KOT work for the station's printer and the
 *    dispatcher prints it; closing queues and prints the bill; the printed
 *    bytes contain the real item and the real total; an on-site agent can
 *    lease the same rows and ack them.
 *  - NEGATIVE: nothing is queued for a branch that switched auto-print off;
 *    nothing is queued when no cashier printer is configured (the browser
 *    path still owns that case); a branch served by a live agent is left
 *    alone by the server-side dispatcher.
 *  - THE D174 INVARIANT, asserted on every path that prints or fails: the
 *    ticket's board status is NEVER written by printing. A successful print
 *    leaves it QUEUED; three failures leave it QUEUED; and the board still
 *    lists it as outstanding either way. D67 wrote PRINTED/FAILED here, and
 *    since D68 that column belongs to the cook (D106 restates it onto the
 *    round and the Orders queue) — a printer moving it would un-prepare a
 *    dish or make the queue lie. That is the whole reason the kitchen board
 *    can safely have paper beside it.
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
 * The interval worker is disabled here (`PRINT_WORKER_ENABLED=false`), so the
 * only drivers are that kick and this explicit call.
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

const board = () =>
  http.request<{ items: { id: string; status: string }[] }>(
    'GET',
    `/restaurant/branches/${branchId}/kitchen-tickets?status=OUTSTANDING`,
    { token: ownerToken() },
  );

const theTicket = () =>
  prisma.kitchenTicket.findFirstOrThrow({ where: { tenantId: restaurant.tenantId } });

describe('D174 — kitchen tickets print when the order is sent', () => {
  it('a submitted round queues an attempt on the station printer, prints it, and the board status is untouched', async () => {
    expect((await sendRound('r1')).status).toBe(201);

    const queued = await prisma.kitchenPrintAttempt.findMany({
      where: { tenantId: restaurant.tenantId },
      include: { ticket: true },
    });
    expect(queued).toHaveLength(1);
    expect(queued[0]!.printerId).toBe(kitchenPrinterId);
    expect(queued[0]!.ticket.status).toBe('QUEUED');
    expect(queued[0]!.ticket.primaryPrinterId).toBe(kitchenPrinterId);

    await waitFor(async () => spooled().length > 0);

    const printed = spooled();
    expect(printed).toHaveLength(1);
    // The industry layout: order type and table as the headline, the
    // station named, quantity first and trimmed for the line cook.
    expect(printed[0]).toContain('DINE IN');
    expect(printed[0]).toContain('TABLE T7');
    expect(printed[0]).toContain('Station: Grill');
    expect(printed[0]).toContain('2   Bottled Beer');
    expect(printed[0]).toContain('2 ITEMS');

    // The attempt is the record of the print…
    const attempt = await prisma.kitchenPrintAttempt.findFirstOrThrow({
      where: { tenantId: restaurant.tenantId },
    });
    expect(attempt.status).toBe('SUCCEEDED');
    expect(attempt.completedAt).not.toBeNull();
    // …and the TICKET is exactly where the board left it. D67 wrote PRINTED
    // here; under D174 that would be a printer moving a card on the pass.
    const ticket = await theTicket();
    expect(ticket.status).toBe('QUEUED');
    const outstanding = await board();
    expect(outstanding.data.items.map((t) => t.id)).toEqual([ticket.id]);
  });

  it('a second round is a second ticket and a second print — rounds are the unit, not orders', async () => {
    expect((await sendRound('r1a')).status).toBe(201);
    expect((await sendRound('r1b', 1)).status).toBe(201);
    await waitFor(async () => spooled().length >= 2);
    // Two tickets, two attempts, two documents. A key that collided on the
    // order would have swallowed the second round as a duplicate.
    expect(await prisma.kitchenTicket.count({ where: { tenantId: restaurant.tenantId } })).toBe(2);
    expect(
      await prisma.kitchenPrintAttempt.count({
        where: { tenantId: restaurant.tenantId, status: 'SUCCEEDED' },
      }),
    ).toBe(2);
    expect(spooled()).toHaveLength(2);
  });

  it('a branch with auto-KOT off leaves the attempt queued and the ticket on the board', async () => {
    await prisma.restaurantBranchConfig.update({
      where: { branchId },
      data: { autoPrintKot: false },
    });
    expect((await sendRound('r2')).status).toBe(201);

    await drain();
    expect(spooled()).toHaveLength(0);
    // The rows still exist — the board has the ticket, and D153 prints by hand.
    expect(
      await prisma.kitchenPrintAttempt.count({
        where: { tenantId: restaurant.tenantId, status: 'PENDING' },
      }),
    ).toBe(1);
    expect((await board()).data.items).toHaveLength(1);
  });

  it('a failing printer exhausts its attempts and NEVER touches the ticket or the order', async () => {
    // An address nothing answers on: the driver reports a real socket error.
    await prisma.kitchenPrinter.update({
      where: { id: kitchenPrinterId },
      data: { kind: 'ESC_POS_NETWORK', address: '127.0.0.1:9' },
    });
    expect((await sendRound('r3')).status).toBe(201);

    // Three attempts, then it gives up. `waitFor` keeps nudging: a drain that
    // overlaps the post-commit kick returns early by design.
    await waitFor(async () => {
      const pending = await prisma.kitchenPrintAttempt.count({
        where: { tenantId: restaurant.tenantId, status: 'PENDING' },
      });
      const failed = await prisma.kitchenPrintAttempt.count({
        where: { tenantId: restaurant.tenantId, status: 'FAILED' },
      });
      return pending === 0 && failed === 3;
    }, 15_000);

    const failed = await prisma.kitchenPrintAttempt.findMany({
      where: { tenantId: restaurant.tenantId, status: 'FAILED' },
    });
    expect(failed).toHaveLength(3);
    expect(failed[0]!.error).toBeTruthy();
    expect(
      await prisma.kitchenPrintAttempt.count({
        where: { tenantId: restaurant.tenantId, status: 'PENDING' },
      }),
    ).toBe(0);

    // THE INVARIANT — the ticket is still QUEUED and still on the board. D67
    // wrote FAILED here, which would have told the pass the dish was gone.
    const ticket = await theTicket();
    expect(ticket.status).toBe('QUEUED');
    expect((await board()).data.items.map((t) => t.id)).toEqual([ticket.id]);
    // The ORDER is untouched — printing can never lose an order (D53/D174).
    expect(
      await prisma.restaurantOrderItem.count({ where: { tenantId: restaurant.tenantId } }),
    ).toBe(1);
  });

  it('the cook can still start and bump a ticket that printed, and the print never un-prepares it', async () => {
    expect((await sendRound('r3b')).status).toBe(201);
    await waitFor(async () => spooled().length > 0);
    const ticket = await theTicket();

    const start = await http.request(
      'POST',
      `/restaurant/branches/${branchId}/kitchen-tickets/${ticket.id}/start`,
      { token: ownerToken() },
    );
    expect(start.status).toBe(201);
    expect((await theTicket()).status).toBe('IN_PROGRESS');

    // A reprint of the same ticket — the operator retries the attempt — must
    // leave IN_PROGRESS alone. The second attempt is a new PENDING row.
    await prisma.kitchenPrintAttempt.create({
      data: { tenantId: restaurant.tenantId, ticketId: ticket.id, printerId: kitchenPrinterId },
    });
    await waitFor(async () => spooled().length >= 2);
    expect(spooled()).toHaveLength(2);
    // The second document says so: it is a REPRINT, and the cook must not
    // start a second portion.
    expect(spooled().some((d) => d.includes('REPRINT'))).toBe(true);
    expect((await theTicket()).status).toBe('IN_PROGRESS');
  });
});

describe('D174 — the bill prints when the order closes', () => {
  it('closing queues a bill job for the branch cashier printer and prints it', async () => {
    await sendRound('r4');
    await drain();

    const closed = await closeSession();
    expect(closed.status).toBe(200);

    const job = await prisma.printJob.findFirstOrThrow({
      where: { tenantId: restaurant.tenantId, type: 'ORDER_BILL' },
    });
    expect(job.printerId).toBe(cashierPrinterId);
    expect(job.saleId).toBe(closed.data.saleId);
    expect(job.branchId).toBe(branchId);

    await waitFor(async () => spooled().some((doc) => doc.includes('TOTAL')));

    // The bill's bytes carry the real document: line, total.
    const bill = spooled().find((doc) => doc.includes('TOTAL'));
    expect(bill).toBeTruthy();
    expect(bill).toContain('Bottled Beer');
    expect(bill).toContain('800.00');

    expect((await prisma.printJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe(
      'PRINTED',
    );
  });

  it('queues NOTHING when the branch has no cashier printer — the browser path owns that case', async () => {
    await prisma.restaurantBranchConfig.update({
      where: { branchId },
      data: { defaultReceiptPrinterId: null },
    });
    await sendRound('r5');
    expect((await closeSession()).status).toBe(200);
    expect(
      await prisma.printJob.count({ where: { tenantId: restaurant.tenantId, type: 'ORDER_BILL' } }),
    ).toBe(0);
  });

  it('queues NOTHING when auto-bill is off, and the close still succeeds', async () => {
    await prisma.restaurantBranchConfig.update({
      where: { branchId },
      data: { autoPrintBill: false },
    });
    await sendRound('r5b');
    expect((await closeSession()).status).toBe(200);
    expect(
      await prisma.printJob.count({ where: { tenantId: restaurant.tenantId, type: 'ORDER_BILL' } }),
    ).toBe(0);
  });

  it('the branch default is the only authority — a second CASHIER printer does not get the job', async () => {
    const other = await prisma.kitchenPrinter.create({
      data: {
        tenantId: restaurant.tenantId,
        branchId,
        code: 'OTHER',
        name: 'Other till',
        kind: 'MOCK',
        address: '',
        role: 'CASHIER',
      },
    });
    await sendRound('r6');
    await closeSession();
    const job = await prisma.printJob.findFirstOrThrow({
      where: { tenantId: restaurant.tenantId, type: 'ORDER_BILL' },
    });
    expect(job.printerId).toBe(cashierPrinterId);
    expect(job.printerId).not.toBe(other.id);
  });
});

describe('D174 — takeaway: the ticket prints at placement, the bill when it settles', () => {
  const placeTakeaway = (key: string, quantity: number) =>
    http.request<{ id: string; orderId: string }>('POST', '/restaurant/takeaway', {
      token: ownerToken(),
      body: {
        branchId,
        idempotencyKey: key,
        items: [{ sourceKind: 'PRODUCT', productId: beerId, quantity }],
      },
    });

  it('placing prints the kitchen ticket and queues no bill yet — there is no Sale to bill from', async () => {
    const res = await placeTakeaway('takeaway-print-1', 3);
    expect(res.status).toBe(201);

    await waitFor(async () => spooled().some((d) => d.includes('Station: Grill')));
    const ticket = spooled().find((d) => d.includes('Station: Grill'));
    expect(ticket).toContain('Bottled Beer');
    expect(ticket).toContain('TAKEAWAY');
    expect(ticket).not.toContain('TABLE');
    expect(
      await prisma.printJob.count({ where: { tenantId: restaurant.tenantId, type: 'ORDER_BILL' } }),
    ).toBe(0);
  });

  it('settling (D117: at payment) queues and prints the bill from the settled Sale', async () => {
    const created = await placeTakeaway('takeaway-print-2', 3);
    const settled = await http.request<{ finalSaleId: string | null }>(
      'POST',
      `/restaurant/takeaway/${created.data.id}/settle`,
      { token: ownerToken() },
    );
    expect(settled.status).toBe(201);
    expect(settled.data.finalSaleId).toBeTruthy();

    const job = await prisma.printJob.findFirstOrThrow({
      where: { tenantId: restaurant.tenantId, type: 'ORDER_BILL' },
    });
    expect(job.saleId).toBe(settled.data.finalSaleId);
    expect(job.printerId).toBe(cashierPrinterId);

    await waitFor(async () => spooled().some((d) => d.includes('TOTAL')));
    const bill = spooled().find((d) => d.includes('TOTAL'));
    // 3 × 400.00, priced by the shared calculator — not recomputed here.
    expect(bill).toContain('1200.00');
  });

  it('handing over after settling does NOT print a second bill', async () => {
    const created = await placeTakeaway('takeaway-print-3', 1);
    await http.request('POST', `/restaurant/takeaway/${created.data.id}/settle`, {
      token: ownerToken(),
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

describe('D174 — transport: an on-site agent takes over from the server', () => {
  const AGENT_TOKEN = 'pat_integration_live_agent_token';

  async function pairLiveAgent(): Promise<string> {
    const { createHash } = await import('node:crypto');
    const agent = await prisma.printAgent.create({
      data: {
        tenantId: restaurant.tenantId,
        branchId,
        name: 'Shop PC',
        tokenHash: createHash('sha256').update(AGENT_TOKEN).digest('hex'),
        lastSeenAt: new Date(),
      },
    });
    return agent.id;
  }

  it('the server dispatcher leaves a branch with a LIVE agent alone', async () => {
    await pairLiveAgent();
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

  it('the agent leases the ticket as ready bytes, acks it, and the ticket stays on the board', async () => {
    await pairLiveAgent();
    await sendRound('r9');

    const leased = await http.request<
      { leaseId: string; source: string; jobId: string; payloadBase64: string; description: string }[]
    >('POST', '/print-agent/lease', {
      headers: { authorization: `Bearer ${AGENT_TOKEN}` },
      body: { maxJobs: 8 },
    });
    expect(leased.status).toBe(201);
    expect(leased.data).toHaveLength(1);
    const job = leased.data[0]!;
    expect(job.source).toBe('KITCHEN');
    expect(job.description).toMatch(/^KOT KOT-/);
    // The agent never renders: what it receives IS the ticket.
    const bytes = Buffer.from(job.payloadBase64, 'base64').toString('latin1');
    expect(bytes).toContain('Station: Grill');
    expect(bytes).toContain('Bottled Beer');

    // Leased means held: a second lease gets nothing, and the server
    // dispatcher cannot see the row either.
    const again = await http.request<unknown[]>('POST', '/print-agent/lease', {
      headers: { authorization: `Bearer ${AGENT_TOKEN}` },
      body: { maxJobs: 8 },
    });
    expect(again.data).toHaveLength(0);

    const ack = await http.request('POST', '/print-agent/ack', {
      headers: { authorization: `Bearer ${AGENT_TOKEN}` },
      body: { leaseId: job.leaseId, ok: true },
    });
    expect(ack.status).toBe(201);

    const attempt = await prisma.kitchenPrintAttempt.findFirstOrThrow({
      where: { tenantId: restaurant.tenantId },
    });
    expect(attempt.status).toBe('SUCCEEDED');
    expect(attempt.leaseId).toBeNull();
    // Same invariant as the direct path: the ticket is the board's.
    expect((await theTicket()).status).toBe('QUEUED');
    expect((await board()).data.items).toHaveLength(1);
  });

  it('a wrong agent token is refused, and reveals nothing', async () => {
    await pairLiveAgent();
    const res = await http.request('POST', '/print-agent/lease', {
      headers: { authorization: 'Bearer pat_not_a_real_token' },
      body: { maxJobs: 8 },
    });
    expect(res.status).toBe(401);
  });

  it('a test page for an agent-served branch is QUEUED for the agent rather than printed from the server', async () => {
    await pairLiveAgent();
    const res = await http.request<{ ok: boolean; queued?: boolean; jobId?: string }>(
      'POST',
      `/restaurant/branches/${branchId}/kitchen-printers/${kitchenPrinterId}/test-print`,
      { token: ownerToken() },
    );
    expect(res.status).toBe(201);
    expect(res.data.queued).toBe(true);
    expect(res.data.jobId).toBeTruthy();
    expect(spooled()).toHaveLength(0);

    const leased = await http.request<{ description: string; payloadBase64: string }[]>(
      'POST',
      '/print-agent/lease',
      { headers: { authorization: `Bearer ${AGENT_TOKEN}` }, body: { maxJobs: 8 } },
    );
    expect(leased.data).toHaveLength(1);
    expect(leased.data[0]!.description).toBe('Test page Kitchen printer');
    expect(Buffer.from(leased.data[0]!.payloadBase64, 'base64').toString('latin1')).toContain(
      'on-site agent',
    );

    const status = await http.request<{ status: string }>(
      'GET',
      `/printing/jobs/${res.data.jobId}`,
      { token: ownerToken() },
    );
    expect(status.status).toBe(200);
    expect(status.data.status).toBe('PENDING');
  });

  it('a test page for a branch with no agent prints from the server now', async () => {
    const res = await http.request<{ ok: boolean; queued?: boolean }>(
      'POST',
      `/restaurant/branches/${branchId}/kitchen-printers/${kitchenPrinterId}/test-print`,
      { token: ownerToken() },
    );
    expect(res.status).toBe(201);
    expect(res.data.ok).toBe(true);
    expect(res.data.queued).toBeUndefined();
    expect(spooled()).toHaveLength(1);
    expect(spooled()[0]).toContain('Printer test page');
    expect(spooled()[0]).toContain('server');
  });
});
