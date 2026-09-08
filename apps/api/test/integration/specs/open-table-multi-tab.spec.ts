/**
 * D104 — one joined table, several tabs.
 *
 * A party of four takes an arrangement of M1+M2 (six seats). Two more guests
 * arrive as a SEPARATE party and take a second tab on the same arrangement,
 * with their own bill. The physical tables come back only when the LAST tab
 * closes.
 *
 * This supersedes two statements that shipped before it: D49's "the
 * arrangement ends with the tab", and the one-live-session-per-table rule in
 * `openSession`. Both are relaxed for `kind = OPEN` ONLY, which is why the last
 * test here re-proves the physical rule rather than trusting that nothing else
 * moved.
 *
 * Non-vacuous per D30. Every claim is paired:
 *
 * - the arrangement SURVIVES the first close (positive) AND its members are
 *   asserted NOT to have gone AVAILABLE (negative) — an implementation that
 *   released nothing at all would satisfy only the second;
 * - the seat check REFUSES an overfilling party (negative) AND admits the same
 *   party at a size that fits (positive) — a server that refused everything
 *   would satisfy only the first;
 * - a PHYSICAL table still refuses a second session, so the relaxation is
 *   proven scoped rather than global.
 *
 * The close-then-release ORDERING is load-bearing and is pinned here:
 * `closeSession` marks its own session CLOSED before the fulfilment provider
 * asks "is anybody else still sitting here", so the plain count in
 * `releaseOpenTable` excludes the tab that is closing. Were that reordered, the
 * last close would see itself as a survivor and never dissolve — which is
 * exactly what the third test would catch.
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
let m1: string;
let m2: string;
let itemId: string;

const token = () =>
  http.tokenFor({
    userId: restaurant.ownerId,
    tenantId: restaurant.tenantId,
    role: 'OWNER',
    activeBranchId: restaurant.branchId,
  });

/**
 * Join M1 + M2 into a named arrangement. `null` seats means the operator
 * recorded none — `undefined` would be swallowed by the default and silently
 * give the caller a six-top, which is exactly the case one test needs to be
 * WITHOUT.
 */
async function createArrangement(seats: number | null = 6) {
  const res = await http.request<{ id: string; code: string; capacity: number | null }>(
    'POST',
    `/restaurant/branches/${branchId}/open-tables`,
    {
      token: token(),
      body: { name: 'Birthday party', ...(seats === null ? {} : { seats }), memberTableIds: [m1, m2] },
    },
  );
  expect(res.status).toBe(201);
  return res.data;
}

/** Unreserve one member, returning the raw response so a refusal can be read. */
function tryRelease(tableId: string) {
  return http.request<{ code?: string }>(
    'POST',
    `/restaurant/branches/${branchId}/open-tables/members/${tableId}/release`,
    { token: token(), body: {} },
  );
}

/** Try to join tables, returning the raw response so a refusal can be read. */
function tryJoin(name: string, memberTableIds: string[]) {
  return http.request<{ id: string; code: string } & { code?: string }>(
    'POST',
    `/restaurant/branches/${branchId}/open-tables`,
    { token: token(), body: { name, seats: 4, memberTableIds } },
  );
}

/** Open one tab, and (optionally) send a round on it so it produces a bill. */
async function openTab(
  tableId: string,
  body: { guestCount?: number; tabName?: string },
) {
  return http.request<{ id: string; sessionNumber: string; tabName: string | null }>(
    'POST',
    `/restaurant/branches/${branchId}/table-sessions`,
    { token: token(), body: { tableId, ...body } },
  );
}

async function sendRound(sessionId: string, key: string) {
  const order = await http.request<{ id: string }>(
    'POST',
    `/restaurant/table-sessions/${sessionId}/orders`,
    { token: token() },
  );
  expect(order.status).toBe(201);
  const round = await http.request(
    'POST',
    `/restaurant/orders/${order.data.id}/rounds`,
    {
      token: token(),
      body: { idempotencyKey: key, items: [{ menuItemId: itemId, quantity: 1 }] },
    },
  );
  expect(round.status).toBe(201);
}

async function closeTab(sessionId: string) {
  return http.request<{
    session: { status: string };
    saleId: string;
    openTableRelease?: {
      released: Array<{ code: string }>;
      stillReserved: Array<{ code: string }>;
      remainingTabs: number;
    };
  }>('POST', `/restaurant/table-sessions/${sessionId}/close`, { token: token(), body: {} });
}

const statusOf = async (id: string) =>
  (await prisma.restaurantTable.findUniqueOrThrow({ where: { id } })).status;

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
    data: { tenantId: restaurant.tenantId, branchId, name: 'Main Hall' },
  });
  const mk = async (code: string, capacity: number) =>
    (
      await prisma.restaurantTable.create({
        data: { tenantId: restaurant.tenantId, branchId, areaId: area.id, code, capacity },
      })
    ).id;
  m1 = await mk('M1', 4);
  m2 = await mk('M2', 2);

  const menu = await prisma.menu.create({
    data: { tenantId: restaurant.tenantId, branchId, name: 'Test Menu' },
  });
  const section = await prisma.menuSection.create({
    data: { tenantId: restaurant.tenantId, menuId: menu.id, name: 'Mains' },
  });
  itemId = (
    await prisma.menuItem.create({
      data: { tenantId: restaurant.tenantId, sectionId: section.id, name: 'Burger', basePrice: '12.50' },
    })
  ).id;
});

describe('D104 — several tabs on one joined table', () => {
  it('two parties share one arrangement and each gets its own Sale', async () => {
    const arrangement = await createArrangement(6);

    const first = await openTab(arrangement.id, { guestCount: 4 });
    expect(first.status).toBe(201);
    // The first tab needs no name: with no sibling, the arrangement's own name
    // is unambiguous.
    expect(first.data.tabName).toBeNull();

    const second = await openTab(arrangement.id, { guestCount: 2, tabName: 'Nuwan' });
    expect(second.status).toBe(201);
    expect(second.data.tabName).toBe('Nuwan');
    expect(second.data.id).not.toBe(first.data.id);

    await sendRound(first.data.id, 'k1');
    await sendRound(second.data.id, 'k2');

    const closeA = await closeTab(first.data.id);
    const closeB = await closeTab(second.data.id);
    expect(closeA.status).toBe(200);
    expect(closeB.status).toBe(200);

    // POSITIVE — two bills, not one, and they are different documents.
    expect(closeA.data.saleId).toBeTruthy();
    expect(closeB.data.saleId).toBeTruthy();
    expect(closeA.data.saleId).not.toBe(closeB.data.saleId);
    const sales = await prisma.sale.findMany({
      where: { id: { in: [closeA.data.saleId, closeB.data.saleId] } },
    });
    expect(sales).toHaveLength(2);
    for (const s of sales) expect(s.total.toFixed(2)).toBe('12.50');
  });

  it('the first close leaves the arrangement standing and frees nothing', async () => {
    const arrangement = await createArrangement(6);
    const first = await openTab(arrangement.id, { guestCount: 4 });
    const second = await openTab(arrangement.id, { guestCount: 2, tabName: 'Nuwan' });
    await sendRound(first.data.id, 'k1');

    const close = await closeTab(first.data.id);
    expect(close.status).toBe(200);

    // POSITIVE — the summary says why nothing moved, rather than returning an
    // empty release that reads as "a shared four-top freed nothing".
    expect(close.data.openTableRelease).toMatchObject({
      released: [],
      stillReserved: [],
      remainingTabs: 1,
    });

    // NEGATIVE — the arrangement is NOT archived and its members did NOT go
    // back to AVAILABLE. Under D49 this close dissolved the whole thing.
    const row = await prisma.restaurantTable.findUniqueOrThrow({ where: { id: arrangement.id } });
    expect(row.isActive).toBe(true);
    expect(await statusOf(m1)).toBe('RESERVED');
    expect(await statusOf(m2)).toBe('RESERVED');
    expect(
      await prisma.openTableMember.count({ where: { openTableId: arrangement.id } }),
    ).toBe(2);

    // …and the surviving tab is still workable, which is the point of all of it.
    expect(second.status).toBe(201);
    const still = await prisma.tableSession.findUniqueOrThrow({ where: { id: second.data.id } });
    expect(still.status).toBe('OPEN');
  });

  it('the LAST close dissolves the arrangement and frees the members', async () => {
    const arrangement = await createArrangement(6);
    const first = await openTab(arrangement.id, { guestCount: 4 });
    const second = await openTab(arrangement.id, { guestCount: 2, tabName: 'Nuwan' });
    await sendRound(first.data.id, 'k1');
    await sendRound(second.data.id, 'k2');

    await closeTab(first.data.id);
    const close = await closeTab(second.data.id);
    expect(close.status).toBe(200);

    // POSITIVE — this is the close that ends the arrangement.
    expect(close.data.openTableRelease?.remainingTabs).toBe(0);
    expect(close.data.openTableRelease?.released.map((t) => t.code).sort()).toEqual(['M1', 'M2']);
    const row = await prisma.restaurantTable.findUniqueOrThrow({ where: { id: arrangement.id } });
    expect(row.isActive).toBe(false);
    expect(await statusOf(m1)).toBe('AVAILABLE');
    expect(await statusOf(m2)).toBe('AVAILABLE');
    expect(
      await prisma.openTableMember.count({ where: { openTableId: arrangement.id } }),
    ).toBe(0);
  });

  it('counts the seats: a party that does not fit is refused, one that fits is not', async () => {
    const arrangement = await createArrangement(6);
    await openTab(arrangement.id, { guestCount: 4 });

    // NEGATIVE — three into the two remaining chairs.
    const tooBig = await openTab(arrangement.id, { guestCount: 3, tabName: 'Nuwan' });
    expect(tooBig.status).toBe(409);
    expect((tooBig.data as unknown as { code: string }).code).toBe('OPEN_TABLE_SEATS_EXHAUSTED');

    // NEGATIVE — and the count is required at all, since seats were recorded.
    const noCount = await openTab(arrangement.id, { tabName: 'Nuwan' });
    expect(noCount.status).toBe(409);
    expect((noCount.data as unknown as { code: string }).code).toBe('GUEST_COUNT_REQUIRED');

    // NEGATIVE — and a second party must be nameable, or the kitchen cannot
    // tell the two tickets apart.
    const noName = await openTab(arrangement.id, { guestCount: 2 });
    expect(noName.status).toBe(409);
    expect((noName.data as unknown as { code: string }).code).toBe('TAB_NAME_REQUIRED');

    // POSITIVE — the same party at a size that fits, named, is admitted. Without
    // this half every assertion above would pass against a server that refused
    // every second tab outright.
    const fits = await openTab(arrangement.id, { guestCount: 2, tabName: 'Nuwan' });
    expect(fits.status).toBe(201);

    // …and now it really is full.
    const full = await openTab(arrangement.id, { guestCount: 1, tabName: 'Third' });
    expect(full.status).toBe(409);
  });

  it('an arrangement with no recorded seat count is not policed (D49)', async () => {
    // "Seating as arranged" is a real answer, and inventing a limit for it
    // would refuse parties on a number nobody stated.
    const arrangement = await createArrangement(null);
    expect(arrangement.capacity).toBeNull();

    expect((await openTab(arrangement.id, {})).status).toBe(201);
    expect((await openTab(arrangement.id, { tabName: 'Nuwan' })).status).toBe(201);
    expect((await openTab(arrangement.id, { tabName: 'Third' })).status).toBe(201);
  });

  it('a PHYSICAL table still refuses a second session — the relaxation is scoped', async () => {
    /*
     * The proof that D104 changed one branch and not the rule. A four-top with
     * a party at it is not a thing two unrelated parties can both be sold; D50
     * already answers that case with a second ARRANGEMENT over the same table.
     */
    const first = await openTab(m1, { guestCount: 2 });
    expect(first.status).toBe(201);

    const second = await openTab(m1, { guestCount: 1, tabName: 'Nuwan' });
    expect(second.status).toBe(409);
    expect((second.data as unknown as { code: string }).code).toBe('TABLE_ALREADY_OPEN');
  });
});

/**
 * D105 — a table already inside an arrangement is not offered to another one.
 *
 * D50 admitted RESERVED members so two unrelated pairs could each hold their
 * own arrangement over one free four-top. That rested on an arrangement meaning
 * exactly ONE tab; D104 ended it, and a member stays RESERVED while its
 * arrangement fills with guests — so the rule was letting a new join be built
 * over tables with people physically sitting at them.
 *
 * Both halves are asserted, and they are the point: refusing is easy to get
 * right by refusing everything, so the last test proves the tables become
 * joinable again the moment they are genuinely free.
 */
describe('D105 — a joined table cannot be joined again', () => {
  it('refuses a member of an UNSEATED arrangement', async () => {
    const first = await createArrangement(6);
    expect(first.id).toBeTruthy();

    const second = await tryJoin('Second pair', [m1]);
    expect(second.status).toBe(409);
    expect((second.data as unknown as { code: string }).code).toBe('OPEN_TABLE_MEMBER_UNAVAILABLE');

    // NEGATIVE — and nothing was written: still exactly one arrangement.
    expect(
      await prisma.restaurantTable.count({ where: { branchId, kind: 'OPEN', isActive: true } }),
    ).toBe(1);
  });

  it('refuses a member of an arrangement that is IN SERVICE', async () => {
    /*
     * The case that prompted D105. Under D50 the member is RESERVED in both
     * states, so a rule written on status alone could not tell "held but
     * empty" from "eight guests are sitting here" — asserting only the
     * unseated case above would have left this one open.
     */
    const first = await createArrangement(6);
    const tab = await openTab(first.id, { guestCount: 4 });
    expect(tab.status).toBe(201);
    await sendRound(tab.data.id, 'k1');

    const second = await tryJoin('Second pair', [m2]);
    expect(second.status).toBe(409);
    expect((second.data as unknown as { code: string }).code).toBe('OPEN_TABLE_MEMBER_UNAVAILABLE');
  });

  it('offers them again once the last tab closes and they are genuinely free', async () => {
    const first = await createArrangement(6);
    const tab = await openTab(first.id, { guestCount: 4 });
    await sendRound(tab.data.id, 'k1');
    const close = await closeTab(tab.data.id);
    expect(close.data.openTableRelease?.remainingTabs).toBe(0);
    expect(await statusOf(m1)).toBe('AVAILABLE');

    // POSITIVE — the same request that was refused twice above now succeeds.
    // Without this the two refusals would pass against a server that had
    // simply started saying no to every join.
    const again = await tryJoin('Later party', [m1, m2]);
    expect(again.status).toBe(201);
  });
});

/**
 * D106 — a member cannot be pulled out from under a seated arrangement.
 *
 * D50 allowed exactly this, for compaction between two arrangements sharing
 * furniture; D105 ended the sharing and D104 made the damage real. The guard it
 * replaced read the MEMBER's own sessions, and a joined member never has one —
 * its tab lives on the open-table row — so it could not fire for the case it
 * appeared to cover.
 *
 * Both directions are asserted. Refusing is trivial to get right by refusing
 * everything, so the unseated release must still work, and the seated one must
 * still come back by the normal route.
 */
describe('D106 — unreserving a member of a live arrangement', () => {
  it('refuses while a tab is open, and leaves the membership intact', async () => {
    const arrangement = await createArrangement(6);
    const tab = await openTab(arrangement.id, { guestCount: 4 });
    expect(tab.status).toBe(201);
    await sendRound(tab.data.id, 'k1');

    const res = await tryRelease(m1);
    expect(res.status).toBe(409);
    expect((res.data as unknown as { code: string }).code).toBe('OPEN_TABLE_IN_SERVICE');

    // NEGATIVE — nothing moved: the membership survives and M1 is still held.
    expect(await statusOf(m1)).toBe('RESERVED');
    expect(
      await prisma.openTableMember.count({ where: { openTableId: arrangement.id } }),
    ).toBe(2);
  });

  it('still releases a member of an arrangement nobody has sat at', async () => {
    /*
     * The positive half. Without it the refusal above would pass just as well
     * against a server that had stopped releasing anything at all — and an
     * unseated arrangement holding tables hostage is a real state (a party that
     * walked out before being seated).
     */
    const arrangement = await createArrangement(6);

    const res = await tryRelease(m1);
    expect(res.status).toBe(200);
    expect(await statusOf(m1)).toBe('AVAILABLE');
    expect(
      await prisma.openTableMember.count({ where: { openTableId: arrangement.id } }),
    ).toBe(1);
  });

  it('gives the member back by itself when the last tab closes', async () => {
    // The route that replaced Unreserve for a seated arrangement (D104).
    const arrangement = await createArrangement(6);
    const tab = await openTab(arrangement.id, { guestCount: 4 });
    await sendRound(tab.data.id, 'k1');
    expect((await tryRelease(m1)).status).toBe(409);

    const close = await closeTab(tab.data.id);
    expect(close.status).toBe(200);
    expect(close.data.openTableRelease?.released.map((t) => t.code).sort()).toEqual(['M1', 'M2']);
    expect(await statusOf(m1)).toBe('AVAILABLE');
    expect(await statusOf(m2)).toBe('AVAILABLE');
    expect(
      (await prisma.restaurantTable.findUniqueOrThrow({ where: { id: arrangement.id } })).isActive,
    ).toBe(false);
  });
});
