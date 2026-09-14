/**
 * D197 — an order has a call number, and it counts per branch per day.
 *
 * `mintOrderNumbers` is one function and its unit spec pins the key it
 * builds; what only a real database can prove is that the key WORKS: the
 * upsert lands on `DocumentSequence`, dine-in and takeaway share one branch
 * counter, a second branch has its own, yesterday's counter is a different
 * row, and the unique index tolerates the null every pre-D197 order carries.
 *
 * D30 — every claim is paired: the order stream is asserted to keep
 * counting tenant-wide right beside the call number restarting, so a build
 * that wired both fields to one counter fails the pair, not just one half.
 */
import { linkUsersToRoles, seedTenantRoles, syncPermissionCatalogue } from '@hardware-pos/database';
import type { PrismaClient } from '@hardware-pos/database';
import { dayInTimeZone, DEFAULT_TIME_ZONE } from '@hardware-pos/shared';

import { connectTestPrisma, disconnectTestPrisma } from '../prisma-test-client';
import { resetDatabase } from '../db-reset';
import { seedSecondTenant, type SeededTenant } from '../fixtures';
import { createHttpIntegrationApp, type HttpIntegrationApp } from '../http-test-app';

let prisma: PrismaClient;
let http: HttpIntegrationApp;
let restaurant: SeededTenant;
let branchId: string;
let areaId: string;
let productId: string;
let tableSeq = 0;

interface OrderRes {
  id: string;
  orderNumber: string;
  callNumber: number | null;
}

const ownerToken = (activeBranchId = branchId) =>
  http.tokenFor({
    userId: restaurant.ownerId,
    tenantId: restaurant.tenantId,
    role: 'OWNER',
    activeBranchId,
  });

/** Today's business day, the way the minter computes it (no settings row → default zone). */
const today = () => dayInTimeZone(new Date(), DEFAULT_TIME_ZONE);

const callCounter = (branch: string, day: string) =>
  prisma.documentSequence.findUnique({
    where: {
      tenantId_docType: { tenantId: restaurant.tenantId, docType: `ORDER_CALL:${branch}:${day}` },
    },
    select: { value: true },
  });

/** A table can hold one open session, so every dine-in order gets a fresh table. */
async function openDineIn(branch = branchId, area = areaId): Promise<OrderRes> {
  tableSeq += 1;
  const table = await prisma.restaurantTable.create({
    data: { tenantId: restaurant.tenantId, branchId: branch, areaId: area, code: `T${tableSeq}`, capacity: 4 },
  });
  const session = await http.request<{ id: string }>(
    'POST',
    `/restaurant/branches/${branch}/table-sessions`,
    { token: ownerToken(branch), body: { tableId: table.id } },
  );
  expect(session.status).toBe(201);
  const order = await http.request<OrderRes>(
    'POST',
    `/restaurant/table-sessions/${session.data.id}/orders`,
    { token: ownerToken(branch) },
  );
  expect(order.status).toBe(201);
  return order.data;
}

async function placeTakeaway(key: string): Promise<OrderRes> {
  const res = await http.request<{ orderId: string; orderNumber: string; callNumber: number | null }>(
    'POST',
    '/restaurant/takeaway',
    {
      token: ownerToken(),
      body: {
        branchId,
        idempotencyKey: key,
        items: [{ sourceKind: 'PRODUCT', productId, quantity: 1 }],
      },
    },
  );
  expect(res.status).toBe(201);
  return { id: res.data.orderId, orderNumber: res.data.orderNumber, callNumber: res.data.callNumber };
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

  const area = await prisma.diningArea.create({
    data: { tenantId: restaurant.tenantId, branchId, name: 'Main' },
  });
  areaId = area.id;
  tableSeq = 0;
  const product = await prisma.product.create({
    data: {
      tenantId: restaurant.tenantId,
      name: 'Fried Rice',
      type: 'Inventory',
      sku: 'RST-RICE',
      unitPrice: '900.00',
      quantityOnHand: '100.000',
      isActive: true,
    },
  });
  productId = product.id;
});

describe('D197 — the call number', () => {
  it('starts at 1 for the branch today, and dine-in and takeaway count on the SAME counter', async () => {
    const first = await openDineIn();
    const second = await placeTakeaway('d197-t-1');
    const third = await openDineIn();

    // POSITIVE — one counter for the branch's day, whichever channel.
    expect([first.callNumber, second.callNumber, third.callNumber]).toEqual([1, 2, 3]);
    expect((await callCounter(branchId, today()))?.value).toBe(3);

    // NEGATIVE (the pair) — the permanent identifier kept its own stream:
    // three orders, three consecutive RO- numbers, none of them "1, 2, 3".
    const seq = (n: string) => Number(n.slice('RO-'.length));
    expect(seq(second.orderNumber)).toBe(seq(first.orderNumber) + 1);
    expect(seq(third.orderNumber)).toBe(seq(second.orderNumber) + 1);

    // …and the row carries both, with the day it counted within.
    const row = await prisma.restaurantOrder.findUniqueOrThrow({
      where: { id: third.id },
      select: { callNumber: true, callDay: true, orderNumber: true },
    });
    expect(row).toEqual({ callNumber: 3, callDay: today(), orderNumber: third.orderNumber });
  });

  it("yesterday's counter is a different row — today starts over regardless of what it reached", async () => {
    // Plant a heavily used counter for yesterday's key.
    const yesterday = dayInTimeZone(new Date(Date.now() - 24 * 60 * 60 * 1000), DEFAULT_TIME_ZONE);
    await prisma.documentSequence.create({
      data: { tenantId: restaurant.tenantId, docType: `ORDER_CALL:${branchId}:${yesterday}`, value: 212 },
    });

    const order = await openDineIn();

    // POSITIVE — today is #1, not #213.
    expect(order.callNumber).toBe(1);
    // NEGATIVE — yesterday's row was not the one that moved.
    expect((await callCounter(branchId, yesterday))?.value).toBe(212);
    expect((await callCounter(branchId, today()))?.value).toBe(1);
  });

  it('a second branch has its own counter on the same day', async () => {
    const other = await prisma.branch.create({
      data: { tenantId: restaurant.tenantId, name: 'Kandy', code: 'KDY' },
    });
    const otherArea = await prisma.diningArea.create({
      data: { tenantId: restaurant.tenantId, branchId: other.id, name: 'Main' },
    });

    const here1 = await openDineIn();
    const here2 = await openDineIn();
    const there1 = await openDineIn(other.id, otherArea.id);

    // POSITIVE — Kandy's first order of the day is #1 while Main is on #2.
    expect([here1.callNumber, here2.callNumber, there1.callNumber]).toEqual([1, 2, 1]);
    // NEGATIVE — the tenant-wide identifier did not restart for Kandy.
    expect(there1.orderNumber).not.toBe(here1.orderNumber);
    expect(Number(there1.orderNumber.slice(3))).toBe(Number(here2.orderNumber.slice(3)) + 1);
  });

  it('the unique index tolerates the null a pre-D197 order carries, and refuses a duplicate live number', async () => {
    const live = await openDineIn();
    // Two legacy rows with no call number on the same branch and day: legal.
    const session = await prisma.tableSession.findFirstOrThrow({
      where: { tenantId: restaurant.tenantId, branchId },
      select: { id: true },
    });
    for (const n of ['RO-900001', 'RO-900002']) {
      await prisma.restaurantOrder.create({
        data: {
          tenantId: restaurant.tenantId,
          branchId,
          sessionId: session.id,
          orderNumber: n,
          callNumber: null,
          callDay: null,
        },
      });
    }
    // A second row claiming today's #1 is not.
    await expect(
      prisma.restaurantOrder.create({
        data: {
          tenantId: restaurant.tenantId,
          branchId,
          sessionId: session.id,
          orderNumber: 'RO-900003',
          callNumber: live.callNumber,
          callDay: today(),
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });
});
