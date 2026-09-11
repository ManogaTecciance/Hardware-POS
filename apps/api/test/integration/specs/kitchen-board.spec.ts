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
 *   • D152's per-station split is asserted on the ROWS as well as on the
 *     board, and never by counting alone: each ticket is matched to the
 *     station it claims AND to the dishes that station's links actually
 *     route, and the union of the tickets' items is asserted equal to the
 *     round's own items. "Two tickets" is satisfiable by a fixture that lost
 *     a dish between them; "exactly these dishes, and no others" is not.
 *   • The Main fallback is asserted at a branch holding four other active
 *     stations, one of them NAMED "Main Kitchen" on a different code. An
 *     unlinked dish reaching a ticket proves nothing at a one-station branch
 *     — D67's retired sole-station sweep did that much — and a build
 *     resolving Main by display name would send it to the demo hot line.
 *   • D174's station cut is asserted with every number DISTINCT — per lane,
 *     per station, and against the branch — so a chip counting the other
 *     station, the branch, or the open lane each land on a different wrong
 *     integer; and with a D147-window ticket on no station that is in the
 *     branch's numbers and in neither station's.
 *   • D175's filters are asserted as SETS of ticket ids over real rows, never
 *     as totals alone, and every negative — a leg gone from the search, a
 *     takeaway absent under a table set, a stationless ticket outside every
 *     station's set — is paired with the read that still finds the same
 *     ticket the way the contract now says it is found.
 */
import {
  seedTenantRoles,
  syncPermissionCatalogue,
  linkUsersToRoles,
} from '@hardware-pos/database';
import type { PrismaClient } from '@hardware-pos/database';
import { Permission } from '@hardware-pos/shared';

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
   * D152 — a REAL station on every ticket this spec cuts: the split is back,
   * and a ticket is one station's slice of one round again. Both fields stay
   * NULLABLE and so does the column — the tickets cut during the D147 window
   * belong to no station and there is no backfill — so the assertions below
   * name the station they expect rather than leaning on the type.
   */
  stationId: string | null;
  stationName: string | null;
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

/** D142b — the three lane chips' numbers, wherever they are read from. */
interface LaneCounts {
  toMake: number;
  preparing: number;
  doneToday: number;
}

/**
 * D154 — ONE TICK of the board: the open lane's cards AND all three chips.
 *
 * This answered with a bare array until D154, and the board followed every
 * tick with a second call to `counts`. The reads below therefore go through
 * `.items`; what they assert about the tickets is unchanged, because the
 * tickets are.
 */
const board = (query = '') =>
  http.request<{ items: TicketView[]; counts: LaneCounts }>(
    'GET',
    `/restaurant/branches/${branchId}/kitchen-tickets${query}`,
    { token: kitchenToken() },
  );

/**
 * D142b — the same three numbers from the route that answers ONLY them.
 *
 * D154 moved the board off this route and deliberately left it standing: it
 * is the cheap read for a caller that wants the chips without the lane. Which
 * is precisely why the two exposures now have to be pinned to each other —
 * see the D154 and D174 describes at the end of this file.
 *
 * D174 — it takes the same `?stationId=` the list does, for the same reason:
 * pinned to a station, the two exposures still have to agree.
 */
const laneCounts = (query = '') =>
  http.request<LaneCounts>(
    'GET',
    `/restaurant/branches/${branchId}/kitchen-tickets/counts${query}`,
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
   * D152 — this link ROUTES again. It stayed in the fixture through the D147
   * window (where the tests asserted it was present and ignored), so the
   * assertions that now read 'Pass' off a card are reading the effect of a
   * link this fixture really makes — not a default, and not the Main
   * fallback, which would have said 'Main'.
   */
  await prisma.productStationLink.create({ data: { productId: product.id, stationId } });
});

describe('D68 — a sent round lands on the kitchen board', () => {
  it('creates a ticket carrying where the food is going, and queues no print work', async () => {
    const sent = await sendRound('no pepper');
    expect(sent.status).toBe(201);

    const res = await board();
    expect(res.status).toBe(200);
    expect(res.data.items).toHaveLength(1);

    // POSITIVE — the ticket is the delivery, so it has to be legible on its
    // own: a dish the pass cannot place never leaves the kitchen.
    const ticket = res.data.items[0]!;
    expect(ticket.status).toBe('QUEUED');
    /*
     * D152 — back to the truth this line asserted before D147, which had
     * rewritten it to `stationId === null` + "no `stationName` on the wire".
     * The product is linked to Pass and to nothing else, so both halves are
     * the LINK's doing; the Main fallback would have said 'Main' here.
     */
    expect(ticket.stationId).toBe(stationId);
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
    expect({ ticketsOnBoard: res.data.items.length, printAttempts: attempts }).toEqual({
      ticketsOnBoard: 1,
      printAttempts: 0,
    });
    const stored = await prisma.kitchenTicket.findFirstOrThrow({
      where: { tenantId: restaurant.tenantId },
      select: { primaryPrinterId: true, stationId: true },
    });
    expect(stored.primaryPrinterId).toBeNull();
    // D152 in the COLUMN, not only in the projection: a board that computed a
    // station name over a row still carrying null would read identically from
    // up there, and the ribbon would go blank on the next reload.
    expect(stored.stationId).toBe(stationId);
    // POSITIVE CONTROL for that id — the link the generator read is really
    // there. Without it, `stationId` could only have been guessed.
    expect(await prisma.productStationLink.count({ where: { productId, stationId } })).toBe(1);
  });

  it('a second round is a second ticket, numbered as round 2', async () => {
    await sendRound();
    await sendRound();
    const res = await board();
    // D152 split the ROUND across stations; it did not merge rounds. Beef
    // Steak routes to Pass and nowhere else, so each round is still exactly
    // one card here — and an order is never folded into a single ticket.
    expect(res.data.items).toHaveLength(2);
    expect(res.data.items.map((t) => t.roundNumber).sort()).toEqual([1, 2]);
    // Oldest first: a kitchen works a queue.
    expect(res.data.items[0]!.roundNumber).toBe(1);
  });
});

/*
 * D152 — the split is back: one ticket per station, and nothing lands on none.
 *
 * D147 had collapsed it. A round became ONE card carrying every dish, with
 * `stationId` null, because the routing underneath was not dependable: the
 * only place to link a dish to a station was the product wizard's
 * branch-scoped Step 3 multi-select, which renders empty when no branch is
 * selected, so dishes were created linked to nothing — and an item linked to
 * nothing reached NO ticket at all unless the branch happened to have exactly
 * one active station (D67's sole-station sweep). Ordered, billed, never
 * cooked.
 *
 * D152 removes both halves of that objection rather than the split: the
 * station is CHOSEN when the menu item is created, and every branch has a
 * `MAIN` station that anything still unlinked routes to. So the cards come
 * back, and the drop does not.
 *
 * This block is written to be hostile to its own claim (D30):
 *
 *   • FOUR active stations before a round is sent, FIVE after — the submit
 *     creates Main. The count is load-bearing in both directions: D67's sweep
 *     rescued an unlinked dish only at a branch with exactly ONE active
 *     station, so "it reached a ticket" proved at a one-station branch would
 *     be indistinguishable from the behaviour D152 replaces.
 *   • One of those stations is NAMED "Main Kitchen", on code `KIT` — the
 *     seed's demo hot line, deliberately distinct from Main. The fallback
 *     resolves by CODE, so every "on Main" assertion below names the id of
 *     the `MAIN`-coded row and asserts the hot line received nothing. A build
 *     that matched the display name would fail here and nowhere else.
 *   • Every split assertion is paired with a UNION check — the multiset of
 *     the tickets' items against the round's own items. "Two tickets" is
 *     satisfiable by a fixture that lost a dish between them; "exactly these
 *     dishes, in these quantities, and no others" is not.
 */
describe('D152 — one ticket per station, and no dish reaches the pass on none', () => {
  let grillProductId: string;
  let pastryProductId: string;
  let unlinkedProductId: string;
  let grillStationId: string;
  let pastryStationId: string;
  /** The seed's demo hot line: called "Main Kitchen", coded `KIT`, NOT Main. */
  let hotLineStationId: string;

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

  const mkStation = async (code: string, name: string) =>
    (
      await prisma.kitchenStation.create({
        data: { tenantId: restaurant.tenantId, branchId, code, name },
      })
    ).id;

  beforeEach(async () => {
    /*
     * FOUR active stations, the shape of the branch that reported the D147
     * defect (Bar, Grill, Main Kitchen, Pastry — the outer fixture's 'Pass'
     * stands in for the fourth). None of them is coded `MAIN`: Main does not
     * exist here until a round is submitted, which is what lets these tests
     * assert it was CREATED rather than found.
     */
    grillStationId = await mkStation('GRILL', 'Grill');
    pastryStationId = await mkStation('PASTRY', 'Pastry');
    hotLineStationId = await mkStation('KIT', 'Main Kitchen');

    grillProductId = await mkProduct('Grilled Seer Fish', 'RST-SEER', grillStationId);
    pastryProductId = await mkProduct('Watalappan', 'RST-WATA', pastryStationId);
    // Linked to nothing at all — still the ordinary case for anything created
    // before D152 put the station on the menu-item form.
    unlinkedProductId = await mkProduct('Chicken Kottu', 'RST-KOTTU', null);
  });

  const send = (idempotencyKey: string, items: { productId: string; quantity: string }[]) =>
    http.request<{ id: string }>('POST', `/restaurant/orders/${orderId}/rounds`, {
      token: ownerToken(),
      body: {
        idempotencyKey,
        items: items.map((i) => ({ sourceKind: 'PRODUCT', ...i })),
      },
    });

  const ticketsFor = (roundId: string) =>
    prisma.kitchenTicket.findMany({
      where: { roundId },
      include: { items: true, station: true },
    });

  /** `{ 'Grill': ['Grilled Seer Fish'], … }` — which station got which dishes. */
  const dishesByStation = (rows: Awaited<ReturnType<typeof ticketsFor>>) =>
    Object.fromEntries(
      rows.map((t) => [
        // '(no station)' rather than a throw: a D147-window ticket legitimately
        // has none, and a regression that produced one here must READ as that
        // rather than as a crashed test.
        t.station?.name ?? '(no station)',
        t.items.map((i) => i.menuItemName).sort(),
      ]),
    );

  /*
   * The claim a lucky fixture cannot satisfy: what the KITCHEN received,
   * against what the WAITER sent, as multisets. Dish names alone would let a
   * dropped second helping through, so the key carries every field a KOT line
   * copies from its round line — the variant snapshot (D46) and the quantity
   * included.
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

  it('two stations mean two cards again, each holding only its own station’s dishes', async () => {
    const sent = await send('d152-two-stations', [
      { productId, quantity: '1' }, // Beef Steak → Pass (outer fixture)
      { productId: grillProductId, quantity: '1' }, // Grilled Seer Fish → Grill
    ]);
    expect(sent.status).toBe(201);

    const rows = await ticketsFor(sent.data.id);
    // POSITIVE — two rows, one per station, each carrying ONLY its own dish.
    expect(rows).toHaveLength(2);
    expect(dishesByStation(rows)).toEqual({
      Pass: ['Beef Steak'],
      Grill: ['Grilled Seer Fish'],
    });
    // The same claim on the IDS, so it cannot pass on two stations that happen
    // to share a display name.
    expect([...rows.map((t) => t.stationId)].sort()).toEqual([stationId, grillStationId].sort());

    /*
     * NEGATIVE — the D147 shape, named as the thing that must not come back:
     * no ticket holds both dishes, and none of them belongs to no station.
     * Counting rows alone would leave "two tickets" green against a build that
     * cut one collapsed card and one empty one.
     */
    expect(rows.some((t) => t.items.length > 1)).toBe(false);
    expect(rows.every((t) => t.stationId !== null)).toBe(true);
    // Two cards on the pass are two KOT numbers: two cards sharing one cannot
    // be told apart by the people calling them out.
    expect(new Set(rows.map((t) => t.ticketNumber)).size).toBe(2);
    rows.forEach((t) => expect(t.ticketNumber).toMatch(/^KOT-\d+$/));

    // …and the board says the same, station NAME and all — the ribbon the
    // card draws reads from this.
    const cards = (await board('?status=OUTSTANDING')).data.items;
    expect(cards).toHaveLength(2);
    expect([...cards.map((c) => c.stationName)].sort()).toEqual(['Grill', 'Pass']);
    expect([...cards.map((c) => c.id)].sort()).toEqual([...rows.map((r) => r.id)].sort());

    /*
     * NOTHING DROPPED between the two of them. The round's lines are PINNED
     * rather than merely compared with the tickets': two equal EMPTY lists
     * would satisfy a bare comparison, so a generator that wrote no items at
     * all has to fail here rather than pass.
     */
    const roundLines = await sentByTheWaiter(sent.data.id);
    expect(roundLines).toEqual(['Beef Steak|—|1.000', 'Grilled Seer Fish|—|1.000']);
    expect(await receivedByTheKitchen(sent.data.id)).toEqual(roundLines);

    /*
     * POSITIVE CONTROL (D30) — the links the split routes on are really there,
     * on two DIFFERENT stations. Delete them and the round would land on Main
     * as one card, which is a shape this test must not be able to accept.
     */
    const links = await prisma.productStationLink.findMany({
      where: { productId: { in: [productId, grillProductId] } },
      select: { stationId: true },
    });
    expect([...links.map((l) => l.stationId)].sort()).toEqual([stationId, grillStationId].sort());
  });

  it('a dish linked to NO station lands on Main — the drop D147 removed the split over', async () => {
    /*
     * THE DEFECT, and the reason the split went rather than a side effect of
     * removing it: at a branch with more than one active station the old
     * routing put an item with no station link on NO ticket at all. It was
     * ordered, it was billed, and the kitchen never saw it.
     *
     * The preconditions are ASSERTED BEFORE the round, not after, because the
     * submit itself changes two of them — it creates Main, taking the branch
     * from four active stations to five.
     */
    expect(await prisma.productStationLink.count({ where: { productId: unlinkedProductId } })).toBe(
      0,
    );
    expect(await prisma.kitchenStation.count({ where: { branchId, isActive: true } })).toBe(4);
    expect(await prisma.kitchenStation.count({ where: { branchId, code: 'MAIN' } })).toBe(0);

    const sent = await send('d152-unlinked', [{ productId: unlinkedProductId, quantity: '3' }]);
    expect(sent.status).toBe(201);

    // POSITIVE — Main was BORN here (it was not there a moment ago), and the
    // round's one ticket belongs to it. The count is asserted before the row
    // is read so a missing Main fails as an assertion, not as a thrown query.
    expect(await prisma.kitchenStation.count({ where: { branchId, code: 'MAIN' } })).toBe(1);
    const main = await mainStation();
    const rows = await ticketsFor(sent.data.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.stationId).toBe(main.id);
    expect(rows[0]!.items.map((i) => i.menuItemName)).toEqual(['Chicken Kottu']);
    expect(rows[0]!.items[0]!.quantity.toFixed(3)).toBe('3.000');

    // Main is what the contract says it is, and it is REACHABLE — an archived
    // Main would take tickets while vanishing from the board's station filter.
    expect({
      code: main.code,
      name: main.name,
      category: main.category,
      isActive: main.isActive,
    }).toEqual({ code: 'MAIN', name: 'Main', category: 'KITCHEN', isActive: true });

    /*
     * NEGATIVE, and the one that separates "resolved by code" from "resolved
     * by whatever is called Main": the branch's "Main Kitchen" hot line is a
     * different row on a different code, and it received nothing.
     */
    expect(rows[0]!.stationId).not.toBe(hotLineStationId);
    expect(await prisma.kitchenTicket.count({ where: { stationId: hotLineStationId } })).toBe(0);

    // …and the card names it, which is what the pass reads.
    const cards = (await board('?status=OUTSTANDING')).data.items;
    expect(cards).toHaveLength(1);
    expect(cards[0]!.stationId).toBe(main.id);
    expect(cards[0]!.stationName).toBe('Main');

    // …and the one line the waiter sent is the one line the kitchen got,
    // PINNED rather than merely compared: two equal empty lists would satisfy
    // a bare comparison between the two sides.
    const roundLines = await sentByTheWaiter(sent.data.id);
    expect(roundLines).toEqual(['Chicken Kottu|—|3.000']);
    expect(await receivedByTheKitchen(sent.data.id)).toEqual(roundLines);
  });

  it('NOTHING IS DROPPED — a mixed round’s tickets hold exactly the round’s dishes', async () => {
    /*
     * The fixture the retired routing would have split three ways while
     * silently losing the last two dishes. Five lines across three linked
     * stations and two dishes linked to nothing; the two orphans must share
     * ONE Main ticket rather than getting a card each, so the pass reads Main
     * as a station and not as a pile of singletons.
     */
    const papadumId = await mkProduct('Papadum', 'RST-PAPADUM', null);
    expect(await prisma.kitchenStation.count({ where: { branchId, isActive: true } })).toBe(4);

    const sent = await send('d152-mixed', [
      { productId, quantity: '1' }, // Pass
      { productId: grillProductId, quantity: '2' }, // Grill
      { productId: pastryProductId, quantity: '1' }, // Pastry
      { productId: unlinkedProductId, quantity: '1' }, // → Main
      { productId: papadumId, quantity: '4' }, // → Main, same ticket
    ]);
    expect(sent.status).toBe(201);

    const main = await mainStation();
    const rows = await ticketsFor(sent.data.id);
    // POSITIVE — four cards for five dishes: three linked stations and Main.
    expect(rows).toHaveLength(4);
    expect(dishesByStation(rows)).toEqual({
      Pass: ['Beef Steak'],
      Grill: ['Grilled Seer Fish'],
      Pastry: ['Watalappan'],
      Main: ['Chicken Kottu', 'Papadum'],
    });
    expect([...rows.map((t) => t.stationId)].sort()).toEqual(
      [stationId, grillStationId, pastryStationId, main.id].sort(),
    );

    /*
     * THE CLAIM THAT CANNOT BE SATISFIED BY A LUCKY FIXTURE — the union of the
     * tickets' items IS the round's items, quantity and variant included. A
     * card count can be right while a dish is missing; this cannot.
     */
    const roundLines = await sentByTheWaiter(sent.data.id);
    expect(roundLines).toEqual([
      'Beef Steak|—|1.000',
      'Chicken Kottu|—|1.000',
      'Grilled Seer Fish|—|2.000',
      'Papadum|—|4.000',
      'Watalappan|—|1.000',
    ]);
    expect(await receivedByTheKitchen(sent.data.id)).toEqual(roundLines);

    // NEGATIVE — neither shape this replaces: not one collapsed card (D147),
    // and not a card per dish (which is what "Main aggregates" rules out).
    expect(rows.some((t) => t.items.length === 5)).toBe(false);
    expect(rows.every((t) => t.stationId !== null)).toBe(true);
    expect(new Set(rows.map((t) => t.ticketNumber)).size).toBe(4);
    // The hot line is still not Main, with four other stations in play.
    expect(await prisma.kitchenTicket.count({ where: { stationId: hotLineStationId } })).toBe(0);

    /*
     * POSITIVE CONTROLS (D30). Without these, everything above would hold for
     * a fixture with nothing to route on and nothing to fall back from:
     *   • three links, on three DIFFERENT stations, still present, and
     *   • two dishes genuinely linked to none, at a branch that now has five
     *     active stations, so no sole-station sweep could have placed them.
     */
    const links = await prisma.productStationLink.findMany({
      where: { productId: { in: [productId, grillProductId, pastryProductId] } },
      select: { stationId: true },
    });
    expect(links).toHaveLength(3);
    expect(new Set(links.map((l) => l.stationId)).size).toBe(3);
    expect(
      await prisma.productStationLink.count({
        where: { productId: { in: [unlinkedProductId, papadumId] } },
      }),
    ).toBe(0);
    expect(await prisma.kitchenStation.count({ where: { branchId, isActive: true } })).toBe(5);
  });

  it('creates Main when the branch has none, reuses it after, and leaves a rename alone', async () => {
    // POSITIVE — it is not there to begin with, so what follows is a creation
    // and not a lucky seed.
    expect(await prisma.kitchenStation.count({ where: { branchId, code: 'MAIN' } })).toBe(0);

    const first = await send('d152-main-1', [{ productId: unlinkedProductId, quantity: '1' }]);
    expect(first.status).toBe(201);
    const main = await mainStation();
    expect({ name: main.name, category: main.category, isActive: main.isActive }).toEqual({
      name: 'Main',
      category: 'KITCHEN',
      isActive: true,
    });
    expect((await ticketsFor(first.data.id))[0]!.stationId).toBe(main.id);

    // …and a second round REUSES it: `@@unique([branchId, code])` is what makes
    // upserting on every submit safe, and a second row would split the pass's
    // Main lane in two.
    const second = await send('d152-main-2', [{ productId: unlinkedProductId, quantity: '1' }]);
    expect(second.status).toBe(201);
    expect(await prisma.kitchenStation.count({ where: { branchId, code: 'MAIN' } })).toBe(1);
    expect((await ticketsFor(second.data.id))[0]!.stationId).toBe(main.id);

    /*
     * The two halves of the upsert's `update`, asserted against each other.
     * An operator renames Main and archives it; the next round must
     *   • restate `isActive` — an archived Main keeps taking tickets while
     *     disappearing from the board's station filter, and Main is the one
     *     station in a branch that must never be unreachable — and
     *   • leave the NAME alone. Someone who renamed Main to "Hot line" meant
     *     it, and the submit is not the place to argue.
     * Testing only the first would stay green against an upsert that restated
     * the name as well, which is the mistake worth catching here.
     */
    await prisma.kitchenStation.update({
      where: { id: main.id },
      data: { name: 'Hot line', isActive: false },
    });
    const third = await send('d152-main-3', [{ productId: unlinkedProductId, quantity: '1' }]);
    expect(third.status).toBe(201);

    const after = await prisma.kitchenStation.findUniqueOrThrow({ where: { id: main.id } });
    expect(after.isActive).toBe(true); // restated
    expect(after.name).toBe('Hot line'); // NOT restated
    expect(await prisma.kitchenStation.count({ where: { branchId, code: 'MAIN' } })).toBe(1);

    const thirdRows = await ticketsFor(third.data.id);
    expect(thirdRows).toHaveLength(1);
    expect(thirdRows[0]!.stationId).toBe(main.id);
    // …and the card carries the operator's own label, not the born one.
    const card = (await board('?status=OUTSTANDING')).data.items.find(
      (c) => c.id === thirdRows[0]!.id,
    )!;
    expect(card.stationName).toBe('Hot line');
  });
});

describe('D68 — kitchen staff complete tickets', () => {
  it('completing moves the ticket off the outstanding board and records who', async () => {
    await sendRound();
    const ticketId = (await board()).data.items[0]!.id;

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
    expect((await board('?status=OUTSTANDING')).data.items).toHaveLength(0);
    const completed = (await board('?status=COMPLETED')).data.items;
    expect(completed.map((t) => t.id)).toEqual([ticketId]);
  });

  it('completing twice does not rewrite who finished it', async () => {
    await sendRound();
    const ticketId = (await board()).data.items[0]!.id;
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
    const ticketId = (await board()).data.items[0]!.id;
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
    const ticketId = (await board()).data.items[0]!.id;
    // Simulate a row written before printing was withdrawn.
    await prisma.kitchenTicket.update({
      where: { id: ticketId },
      data: { status: 'PRINTED' },
    });

    const outstanding = (await board('?status=OUTSTANDING')).data.items;
    expect(outstanding.map((t) => t.id)).toEqual([ticketId]);
    // NEGATIVE — and it is not being counted as finished work.
    expect((await board('?status=COMPLETED')).data.items).toHaveLength(0);
  });
});

describe('D68 — the kitchen role reaches the board and nothing else', () => {
  it('kitchen staff can complete a ticket but cannot close the table or take payment', async () => {
    await sendRound();
    const ticketId = (await board()).data.items[0]!.id;

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
 * D156 — a waiter sees the whole floor, and the narrowing is permission-driven.
 *
 * ## What changed, and why the pairs are the other way up now
 *
 * D70 withheld `TABLE_SESSION_VIEW_ALL` from the Waiter template, so these
 * cases used to assert the opposite of what they assert below: waiter A could
 * not see, read or write waiter B's table. D156 grants the key, because the
 * mixing D70 was protecting against is a question of DEFAULTS (the floor plan
 * and the POS picker open on "my tables") and withholding the read made the
 * routine case of table service impossible — covering a colleague on a break, a
 * shift change mid-service, answering a guest about an order you did not take.
 *
 * ## Why the narrowing is still asserted
 *
 * The server-side scope is unchanged and still the authority: it is keyed on a
 * permission, and a tenant can compose a role without it through RolesApi. No
 * seeded template lacks it any more, so a spec that exercised only the seeded
 * roles would leave `sessionScope()` asserted in ONE direction — the shape D30
 * calls vacuous. `trainee` below is the second direction: a custom role with
 * TABLE_VIEW and no VIEW_ALL, narrowed exactly as a waiter used to be, through
 * the same routes in the same test.
 *
 * Mutation-proven (run against the template itself): removing
 * `TABLE_SESSION_VIEW_ALL` from the Waiter template — i.e. reverting to D70 —
 * fails exactly the three waiter-facing cases (the floor listing with its
 * names, the per-id reads, the colleague's-table writes) and leaves the
 * supervisor case and the TRAINEE_WAITER control green: 3 failed, 29 passed.
 */
describe('D156 — session visibility is the floor, narrowed by permission', () => {
  let waiterA: string;
  let waiterB: string;
  let sessionA: string;
  let sessionB: string;
  let cashier: string;
  /** A custom role WITHOUT TABLE_SESSION_VIEW_ALL — the negative control. */
  let trainee: string;
  let sessionTrainee: string;

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
    /*
     * Composed here rather than taken from a template: every seeded role now
     * carries the key, and the point of this one is that it does not. The
     * permissions it connects to are the catalogue rows the seed syncs.
     */
    const traineeRole = await prisma.role.create({
      data: {
        tenantId: restaurant.tenantId,
        key: 'TRAINEE_WAITER',
        name: 'Trainee waiter',
        description: 'Own tables only — no TABLE_SESSION_VIEW_ALL.',
        /*
         * Connected through the enum, not by hand-written strings: the
         * catalogue keys are the enum's VALUES (`table:view`, not
         * `TABLE_VIEW`), and a key that does not exist makes `connect` throw
         * — which would read as a broken fixture rather than as the typo it is.
         */
        permissions: {
          connect: [
            Permission.TABLE_VIEW,
            Permission.TABLE_OPEN,
            Permission.TABLE_CLOSE,
            Permission.ORDER_CREATE,
            Permission.ORDER_SEND_TO_KITCHEN,
          ].map((key) => ({ key })),
        },
      },
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
    trainee = await mk('Trainee', 'trainee@fixture.test', traineeRole.id);

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
    sessionTrainee = await seat('B3', trainee);
  });

  it('lists the floor to a waiter, and names whose each table is', async () => {
    const forA = await http.request<{ id: string; waiterName: string | null }[]>(
      'GET',
      `/restaurant/branches/${branchId}/open-sessions`,
      { token: tokenFor(waiterA) },
    );
    const ids = forA.data.map((s) => s.id);
    // POSITIVE — their own table…
    expect(ids).toContain(sessionA);
    // …and their colleague's, which D70 withheld.
    expect(ids).toContain(sessionB);

    /*
     * D156 — the NAME, because "my tables / all tables" is unusable without
     * it: the client has only a cuid otherwise, and the users endpoint it
     * would resolve a name through is USER_MANAGE-gated (a waiter holds
     * nothing of the sort).
     */
    expect(forA.data.find((s) => s.id === sessionB)?.waiterName).toBe('Waiter B');
    expect(forA.data.find((s) => s.id === sessionA)?.waiterName).toBe('Waiter A');

    // The mirror image, so this is the floor and not a list that happens to
    // favour whoever asked first.
    const forB = await http.request<{ id: string }[]>(
      'GET',
      `/restaurant/branches/${branchId}/open-sessions`,
      { token: tokenFor(waiterB) },
    );
    expect(forB.data.map((s) => s.id)).toEqual(expect.arrayContaining([sessionA, sessionB]));
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

  it('lets a waiter read a colleague session by id, on every read route', async () => {
    for (const path of [
      `/restaurant/table-sessions/${sessionB}`,
      `/restaurant/table-sessions/${sessionB}/detail`,
    ]) {
      const mine = path.replace(sessionB, sessionA);
      // Their own, and their colleague's, through the same route: both 200.
      expect((await http.request('GET', mine, { token: tokenFor(waiterA) })).status).toBe(200);
      expect((await http.request('GET', path, { token: tokenFor(waiterA) })).status).toBe(200);
    }
  });

  it('lets a waiter work a colleague table — covering is the point of seeing it', async () => {
    /*
     * Deliberate, and it reads both ways: a waiter who can SEE a colleague's
     * table and then cannot add the round the guests just asked for has been
     * handed a door onto a 403, which is what D93 says not to build. Sending a
     * round never checked ownership in the first place (only
     * ORDER_SEND_TO_KITCHEN), so all that changes here is that the
     * session-addressed routes stop refusing. Every one of them is audited with
     * the actor's id, which is where accountability lives — not in pretending
     * the table is invisible.
     */
    expect(
      (
        await http.request('POST', `/restaurant/table-sessions/${sessionB}/orders`, {
          token: tokenFor(waiterA),
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await http.request('POST', `/restaurant/table-sessions/${sessionB}/close`, {
          token: tokenFor(waiterA),
          body: { idempotencyKey: 'x1' },
        })
      ).status,
    ).toBe(200);
  });

  it('NEGATIVE CONTROL — a role without the key is still narrowed to its own sessions', async () => {
    const mine = await http.request<{ id: string }[]>(
      'GET',
      `/restaurant/branches/${branchId}/open-sessions`,
      { token: tokenFor(trainee) },
    );
    // Their own table only: the scope the waiter used to live under is still
    // here, still enforced, for a role composed without the permission.
    expect(mine.data.map((s) => s.id)).toEqual([sessionTrainee]);

    for (const path of [
      `/restaurant/table-sessions/${sessionA}`,
      `/restaurant/table-sessions/${sessionA}/detail`,
    ]) {
      const own = path.replace(sessionA, sessionTrainee);
      // POSITIVE CONTROL — their own session answers 200 on the same route, so
      // the 404s below are about ownership and not a broken token.
      expect((await http.request('GET', own, { token: tokenFor(trainee) })).status).toBe(200);
      // 404 rather than 403: the response must not confirm that the session
      // exists and belongs to someone else.
      expect((await http.request('GET', path, { token: tokenFor(trainee) })).status).toBe(404);
    }

    // And the writes, which hiding alone would not cover.
    expect(
      (
        await http.request('POST', `/restaurant/table-sessions/${sessionA}/orders`, {
          token: tokenFor(trainee),
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await http.request('POST', `/restaurant/table-sessions/${sessionA}/close`, {
          token: tokenFor(trainee),
          body: { idempotencyKey: 'x2' },
        })
      ).status,
    ).toBe(404);
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
    const ticketId = (await board()).data.items[0]!.id;
    expect(await unifiedFor(orderId)).toBe('PENDING');

    const started = await verb(ticketId, 'start');
    expect(started.data.status).toBe('IN_PROGRESS');
    // Starting is not bumping: the ticket is still outstanding work…
    expect((await board('?status=OUTSTANDING')).data.items.map((t) => t.id)).toEqual([ticketId]);
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
    const ticketId = (await board()).data.items[0]!.id;

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
    const takeawayTicket = (await board('?status=OUTSTANDING')).data.items.find(
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
  // D154 — the same envelope the board reads; this describe's own reader
  // because it goes through the kitchen token deliberately.
  const boardAs = (query: string) =>
    http.request<{ items: TicketView[]; counts: LaneCounts }>(
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
    const t = (await boardAs('?status=OUTSTANDING')).data.items.find(
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
    expect((await boardAs('?status=OUTSTANDING')).data.items.map((t) => t.id)).toContain(ticketId);
    expect((await boardAs('?status=CANCELLED')).data.items).toHaveLength(0);

    await cancel(profileId);

    expect((await boardAs('?status=OUTSTANDING')).data.items.map((t) => t.id)).not.toContain(
      ticketId,
    );
    expect((await boardAs('?status=CANCELLED')).data.items.map((t) => t.id)).toEqual([ticketId]);
  });

  it('a completed ticket of a cancelled order leaves Done for Cancelled too', async () => {
    const { profileId, ticketId } = await createTakeaway('d108-b');
    await http.request(
      'POST',
      `/restaurant/branches/${branchId}/kitchen-tickets/${ticketId}/complete`,
      { token: kitchenToken() },
    );
    expect((await boardAs('?status=COMPLETED')).data.items.map((t) => t.id)).toContain(ticketId);

    await cancel(profileId);

    expect((await boardAs('?status=COMPLETED')).data.items.map((t) => t.id)).not.toContain(
      ticketId,
    );
    expect((await boardAs('?status=CANCELLED')).data.items.map((t) => t.id)).toContain(ticketId);
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
    const t = (await board('?status=OUTSTANDING')).data.items.find(
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
    const ticketId = (await board()).data.items[0]!.id;

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
    const todayTicket = (await board('?status=OUTSTANDING')).data.items[0]!.id;
    await bump(todayTicket);

    await sendRound();
    const oldTicket = (await board('?status=OUTSTANDING')).data.items[0]!.id;
    await bump(oldTicket);
    await backdate(oldTicket, 3);

    const lane = (await board('?status=COMPLETED_TODAY')).data.items.map((t) => t.id);
    // POSITIVE: today's bump is on the lane…
    expect(lane).toContain(todayTicket);
    // …NEGATIVE: three days ago is not.
    expect(lane).not.toContain(oldTicket);

    // And the ticket still exists, in both of the places it should: the
    // unscoped COMPLETED list the KDS route and a bookmark still mean…
    const everCompleted = (await board('?status=COMPLETED')).data.items.map((t) => t.id);
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
    const first = (await board('?status=OUTSTANDING')).data.items[0]!.id;
    await bump(first);
    await backdate(first, 5);

    await sendRound();
    const second = (await board('?status=OUTSTANDING')).data.items[0]!.id;
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
     * D152 — the station is back on the history row, and this line is back to
     * the truth it asserted before D147 rewrote it to "no `stationName`, null
     * `stationId`". Beef Steak is linked to Pass and nothing else, so 'Pass'
     * is what the LINK produced: an unrouted dish would read 'Main'.
     */
    expect(items[0]!.stationName).toBe('Pass');
    expect(items[0]!.stationId).toBe(stationId);
    expect(items[0]!.placeLabel).toBe('T7 · Terrace');
    expect(items[0]!.orderNumber).toMatch(/^RO-\d+$/);
  });

  it('pages, and the count is of the whole set rather than the page', async () => {
    const ticketIds: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      await sendRound();
      const id = (await board('?status=OUTSTANDING')).data.items[0]!.id;
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

  it('searches the ticket number and the dish; the station and the table are filters now', async () => {
    await sendRound();
    const ticketId = (await board('?status=OUTSTANDING')).data.items[0]!.id;
    const bumped = await bump(ticketId);
    const ticketNumber = bumped.data.ticketNumber;
    const dish = bumped.data.items[0]!.menuItemName;

    // POSITIVE, three ways in: its own number, a lower-case fragment of the
    // dish, and nothing at all.
    expect((await history(`?search=${encodeURIComponent(ticketNumber)}`)).data.total).toBe(1);
    const fragment = dish.slice(0, 4).toLowerCase();
    expect((await history(`?search=${encodeURIComponent(fragment)}`)).data.total).toBe(1);
    expect((await history()).data.total).toBe(1);
    /*
     * D175 — the STATION is no longer a way in through the search box.
     *
     * D152 had put a station-name leg on the search, and this test asserted
     * that `?search=pass` found the ticket. That is genuinely false now, so
     * it is rewritten to the new truth rather than deleted (D16): 'pass'
     * matches no KOT number, no RO number and no dish, and the leg that used
     * to carry it to the station join is gone — "what did the grill have on
     * last Friday" is asked of the station FILTER instead.
     *
     * The claim is made over the exact set of station names the branch has —
     * Pass, which cooked this ticket, and Main, which the submit created and
     * did not — rather than over one name typed into the spec. 'pass' is the
     * line that discriminates: 1 before D175, 0 now. 'main' was 0 both before
     * and after (the retired leg matched the ticket's OWN station, and that
     * pair used to prove it), and is here so the set is the whole set.
     */
    const stationNames = (
      await prisma.kitchenStation.findMany({ where: { branchId }, select: { name: true } })
    ).map((s) => s.name);
    expect([...stationNames].sort()).toEqual(['Main', 'Pass']);
    for (const name of stationNames) {
      const total = (await history(`?search=${encodeURIComponent(name.toLowerCase())}`)).data.total;
      expect({ name, total }).toEqual({ name, total: 0 });
    }
    /*
     * POSITIVE CONTROLS for those zeroes (D30). The ticket really IS Pass's —
     * the name is on the row this same read returns — and the station is
     * still a way in, through the structured filter that replaced the leg.
     * Without both, the zeroes would also hold for a fixture that never
     * linked the dish to Pass, and for a build that had lost the station.
     */
    const row = (await history()).data.items[0]!;
    expect(row.stationName).toBe('Pass');
    expect((await history(`?stationId=${stationId}`)).data.items.map((t) => t.id)).toEqual([
      ticketId,
    ]);
    /*
     * D175 — the TABLE/tab/area leg went with it. 'T7' and 'terrace' are both
     * on this row's own place label and neither finds anything now; the
     * table is `?tableId=`, and that read is the positive paired with them.
     */
    expect(row.placeLabel).toBe('T7 · Terrace');
    expect((await history('?search=T7')).data.total).toBe(0);
    expect((await history('?search=terrace')).data.total).toBe(0);
    const t7 = await prisma.restaurantTable.findFirstOrThrow({
      where: { branchId, code: 'T7' },
      select: { id: true },
    });
    expect((await history(`?tableId=${t7.id}`)).data.items.map((t) => t.id)).toEqual([ticketId]);
    // NEGATIVE — a term that matches nothing returns nothing, so the positives
    // above are not simply an unfiltered list.
    expect((await history('?search=zzzznotathing')).data.total).toBe(0);
  });

  it('leaves cancelled work out of both the lane and the history (D115)', async () => {
    await sendRound();
    const ticketId = (await board('?status=OUTSTANDING')).data.items[0]!.id;
    await bump(ticketId);
    // POSITIVE first, so the negatives below cannot pass on an empty branch.
    expect((await history()).data.items.map((t) => t.id)).toContain(ticketId);

    await prisma.restaurantOrder.update({
      where: { id: orderId },
      data: { status: 'CANCELLED' },
    });

    expect((await board('?status=COMPLETED_TODAY')).data.items.map((t) => t.id)).not.toContain(
      ticketId,
    );
    expect((await history()).data.items.map((t) => t.id)).not.toContain(ticketId);
    // …and it is still findable where cancelled work belongs.
    expect((await board('?status=CANCELLED')).data.items.map((t) => t.id)).toContain(ticketId);
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
    const queued = (await board('?status=OUTSTANDING')).data.items[0]!.id;
    await sendRound();
    const preparing = (await board('?status=OUTSTANDING')).data.items.find(
      (t) => t.id !== queued,
    )!.id;
    await http.request(
      'POST',
      `/restaurant/branches/${branchId}/kitchen-tickets/${preparing}/start`,
      { token: kitchenToken() },
    );
    await sendRound();
    const done = (await board('?status=OUTSTANDING')).data.items.find(
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
    expect([...(await board('?status=OUTSTANDING')).data.items.map((t) => t.id)].sort()).toEqual(
      [queued, preparing].sort(),
    );
    expect((await board('?status=COMPLETED_TODAY')).data.items.map((t) => t.id)).toEqual([done]);
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
    const kept = (await board('?status=OUTSTANDING')).data.items[0]!.id;
    await sendRound();
    const calledOff = (await board('?status=OUTSTANDING')).data.items.find(
      (t) => t.id !== kept,
    )!.id;

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
    expect([...(await board('?status=CANCELLED')).data.items.map((t) => t.id)].sort()).toEqual(
      [kept, calledOff].sort(),
    );
  });

  it('is the kitchen’s to read — the same permission as the board', async () => {
    await sendRound();
    await bump((await board('?status=OUTSTANDING')).data.items[0]!.id);

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
    const queued = (await board('?status=OUTSTANDING')).data.items[0]!.id;
    await sendRound();
    const starting = (await board('?status=OUTSTANDING')).data.items.find(
      (t) => t.id !== queued,
    )!.id;
    await http.request(
      'POST',
      `/restaurant/branches/${branchId}/kitchen-tickets/${starting}/start`,
      { token: kitchenToken() },
    );
    await sendRound();
    const bumped = (await board('?status=OUTSTANDING')).data.items.find(
      (t) => t.id !== queued && t.id !== starting,
    )!.id;
    await bump(bumped);

    const outstanding = (await board('?status=OUTSTANDING')).data.items;
    const done = (await board('?status=COMPLETED_TODAY')).data.items;
    const counts = (await laneCounts()).data;

    expect(counts.toMake).toBe(outstanding.filter((t) => t.status !== 'IN_PROGRESS').length);
    expect(counts.preparing).toBe(outstanding.filter((t) => t.status === 'IN_PROGRESS').length);
    expect(counts.doneToday).toBe(done.length);
    // POSITIVE — and the numbers are the real ones, not three zeroes agreeing.
    expect(counts).toEqual({ toMake: 1, preparing: 1, doneToday: 1 });
  });

  it('counts the DAY on Done, like the lane does', async () => {
    await sendRound();
    const old = (await board('?status=OUTSTANDING')).data.items[0]!.id;
    await bump(old);
    expect((await laneCounts()).data.doneToday).toBe(1);

    await backdate(old, 3);

    // NEGATIVE — out of today's window, out of the count, exactly as it is out
    // of the lane. A count over every COMPLETED row would still say 1.
    expect((await laneCounts()).data.doneToday).toBe(0);
    expect((await board('?status=COMPLETED_TODAY')).data.items).toHaveLength(0);
    // …and it is still there unscoped, so the zero above is a window and not a
    // deletion.
    expect((await board('?status=COMPLETED')).data.items.map((t) => t.id)).toContain(old);
  });

  it('leaves cancelled work out of every count, like every lane (D115)', async () => {
    await sendRound();
    const ticketId = (await board('?status=OUTSTANDING')).data.items[0]!.id;
    expect((await laneCounts()).data.toMake).toBe(1);

    await prisma.restaurantOrder.update({
      where: { id: orderId },
      data: { status: 'CANCELLED' },
    });

    const counts = (await laneCounts()).data;
    expect(counts).toEqual({ toMake: 0, preparing: 0, doneToday: 0 });
    expect((await board('?status=CANCELLED')).data.items.map((t) => t.id)).toContain(ticketId);
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

/*
 * D154 — the chips ride along with the cards, and the two exposures of them
 * cannot drift apart.
 *
 * A board tick used to be TWO requests: the lane, then `counts`. The list now
 * answers with both, and `counts` deliberately stays for a caller that wants
 * the three integers without reading every ticket and its items to get them.
 * Two routes serving the same three numbers is precisely the shape that rots
 * — one gets a new lane rule, a new exclusion, a new day boundary, and the
 * other quietly does not — so the claim worth pinning is that they cannot.
 *
 * It has to be an integration test. A unit test can prove the service builds
 * both from one shared query; it cannot prove that the two ROUTES, with their
 * own guards, their own params and their own serialisation, hand a caller the
 * same numbers over real rows.
 */
describe('D154 — the list envelope carries the counts route’s own numbers', () => {
  it('matches the counts endpoint on every lane filter, cards or no cards', async () => {
    /*
     * Seven rounds, arranged so the three chips hold three DIFFERENT non-zero
     * numbers AND so the Done chip is genuinely day-scoped. Equality between
     * two objects of three zeroes is satisfied by a build that counts nothing
     * at all; equality between {1,1,1} and {1,1,1} survives two of the chips
     * being transposed; and a fixture whose only bumped ticket was bumped
     * today cannot tell D142's "finished today" from "finished ever" on
     * EITHER exposure — the mutant that drops the day bound from the counts
     * route alone survives such a fixture, which is how this arrangement was
     * arrived at rather than by preference.
     */
    for (let i = 0; i < 7; i += 1) await sendRound();
    const queue = (await board('?status=OUTSTANDING')).data.items.map((t) => t.id);
    expect(queue).toHaveLength(7);

    await bump(queue[0]!); // Done TODAY: 1
    await bump(queue[1]!);
    await backdate(queue[1]!, 3); // Completed, but not today — chip must not see it.
    for (const id of [queue[2]!, queue[3]!]) {
      await http.request('POST', `/restaurant/branches/${branchId}/kitchen-tickets/${id}/start`, {
        token: kitchenToken(),
      });
    } // Preparing: 2 — which leaves three still To make.

    const standalone = (await laneCounts()).data;
    // POSITIVE — the standalone route's numbers, NAMED. Without this anchor an
    // equality between the two exposures is satisfied by both being wrong
    // together, which is exactly what a change to the shared query would do.
    expect(standalone).toEqual({ toMake: 3, preparing: 2, doneToday: 1 });

    /*
     * EVERY lane, the ones the numbers are not about included. D142b's rule
     * is that a chip carries its number whichever lane is open, so the
     * envelope's counts must not move with `?status=`. A test that only read
     * the default lane would pass just as happily against a build that
     * counted the FILTERED rows.
     */
    const lanes = [
      '',
      '?status=OUTSTANDING',
      '?status=COMPLETED_TODAY',
      '?status=COMPLETED',
      '?status=CANCELLED',
    ];
    for (const filter of lanes) {
      const tick = await board(filter);
      expect(tick.status).toBe(200);
      // The lane travels INSIDE the compared value: jest's `expect` takes no
      // message argument, and a bare `toEqual` failing on the fifth iteration
      // would not say which `?status=` produced the mismatch.
      expect({ filter, counts: tick.data.counts }).toEqual({ filter, counts: standalone });
    }

    /*
     * …and those were five DIFFERENT reads. Without this, a build that
     * ignored `?status=` entirely — answering the whole board five times —
     * would satisfy every assertion above.
     *
     * The Cancelled lane is the sharpest: ZERO cards, and the chips still say
     * 3/2/1, a shape no count-what-I-returned implementation can produce.
     * That it is empty here is a fact about this fixture, not a claim that
     * the filter selects nothing — the D115 describe above puts a real ticket
     * into it and reads it back.
     */
    const cancelled = await board('?status=CANCELLED');
    expect(cancelled.data.items).toHaveLength(0);
    expect(cancelled.data.counts).toEqual({ toMake: 3, preparing: 2, doneToday: 1 });
    // The day bound is live in the LIST as well as in the chip: two tickets
    // have been bumped, one of them yesterday-ish, and only one is on Done.
    expect((await board('?status=COMPLETED_TODAY')).data.items.map((t) => t.id)).toEqual([
      queue[0]!,
    ]);
    expect([...(await board('?status=COMPLETED')).data.items.map((t) => t.id)].sort()).toEqual(
      [queue[0]!, queue[1]!].sort(),
    );
    expect([...(await board('?status=OUTSTANDING')).data.items.map((t) => t.id)].sort()).toEqual(
      [...queue.slice(2)].sort(),
    );
  });
});

/*
 * D174 — a station scopes the list AND the counts, together, over real rows.
 *
 * The PO's report: on the kitchen page the Done tab carried a number only
 * while "All stations" was selected. That was D152's own doing — on the lane
 * the board was not fetching, `laneCount` answered null under a station cut,
 * because the counts came from the server and the server counted the BRANCH,
 * and "Done 7" over a lane about to draw the grill's two cards was judged
 * worse than no number. The PO ruled otherwise: D142b's rule that EVERY chip
 * carries its number holds under a station cut too, and the number is that
 * station's own. So `?stationId=` narrows the list and all three counts in
 * the one snapshot D154 made, and the standalone counts route takes the same
 * param so the two exposures stay pinned to each other.
 *
 * The unit specs pin the SHAPE — one station key on all four queries, in one
 * transaction. What only real rows can prove is that Postgres, given that
 * shape, hands back the station's tickets AND the station's numbers, and that
 * the counts route — its own DTO, its own guard — says the same three
 * integers. The fixture is therefore built the way D154's was, with every
 * number DISTINCT per lane, per station, and against the branch, so a chip
 * counting the other station, the branch, or the open lane each land on a
 * different wrong integer:
 *
 *   Pass    { 4, 2, 1 }
 *   Grill   { 2, 1, 3 }   plus one bumped three days ago: completed, NOT today
 *   (none)  { 1, 0, 0 }   a D147-window ticket, its stationId nulled by hand
 *   branch  { 7, 3, 4 }   = Pass + Grill + (none), lane by lane
 *
 * The stationless row is load-bearing. D174 says a ticket cut during the D147
 * window belongs to NO station and is therefore in no station's count, while
 * it is still in the "All stations" numbers. Without it the branch total would
 * simply be the two stations' sum, and a build that folded a null-station row
 * into whichever station was asked for would pass every assertion here.
 */
describe('D174 — a station scopes the list and the counts together', () => {
  let grillStationId: string;
  let grillProductId: string;
  interface Lanes {
    queued: string[];
    preparing: string[];
    doneToday: string[];
  }
  let pass: Lanes;
  /** Grill also holds a ticket bumped OUTSIDE the day: completed, not Done. */
  let grill: Lanes & { doneBefore: string };
  /** The D147-window shape: a real, queued ticket on no station at all. */
  let stationless: string;

  const PASS_COUNTS: LaneCounts = { toMake: 4, preparing: 2, doneToday: 1 };
  const GRILL_COUNTS: LaneCounts = { toMake: 2, preparing: 1, doneToday: 3 };
  const BRANCH_COUNTS: LaneCounts = { toMake: 7, preparing: 3, doneToday: 4 };
  const NOTHING: LaneCounts = { toMake: 0, preparing: 0, doneToday: 0 };

  const start = (ticketId: string) =>
    http.request('POST', `/restaurant/branches/${branchId}/kitchen-tickets/${ticketId}/start`, {
      token: kitchenToken(),
    });

  /** The ids on a page, order-free: the lanes sort by different keys. */
  const ids = (res: { data: { items: TicketView[] } }) =>
    [...res.data.items.map((t) => t.id)].sort();

  /** One round holding a dish for EACH station: two tickets, keyed by station. */
  const sendPair = async (key: string) => {
    const sent = await http.request<{ id: string }>(
      'POST',
      `/restaurant/orders/${orderId}/rounds`,
      {
        token: ownerToken(),
        body: {
          idempotencyKey: key,
          items: [
            { sourceKind: 'PRODUCT', productId, quantity: '1' }, // Beef Steak → Pass
            { sourceKind: 'PRODUCT', productId: grillProductId, quantity: '1' }, // → Grill
          ],
        },
      },
    );
    expect(sent.status).toBe(201);
    const rows = await prisma.kitchenTicket.findMany({
      where: { roundId: sent.data.id },
      select: { id: true, stationId: true },
    });
    // D152's split, relied on rather than re-proven here: exactly one ticket
    // per station. A fixture that lost one must fail HERE, not three
    // assertions later as an off-by-one in a chip.
    expect([...rows.map((r) => r.stationId)].sort()).toEqual([stationId, grillStationId].sort());
    return {
      pass: rows.find((r) => r.stationId === stationId)!.id,
      grill: rows.find((r) => r.stationId === grillStationId)!.id,
    };
  };

  beforeEach(async () => {
    const station = await prisma.kitchenStation.create({
      data: { tenantId: restaurant.tenantId, branchId, code: 'GRILL', name: 'Grill' },
    });
    grillStationId = station.id;
    const product = await prisma.product.create({
      data: {
        tenantId: restaurant.tenantId,
        name: 'Grilled Seer Fish',
        type: 'Inventory',
        sku: 'RST-SEER',
        unitPrice: '900.00',
        // D65 — a round DEPLETES stock at submit; seven of them need it.
        quantityOnHand: '100.000',
        isActive: true,
      },
    });
    grillProductId = product.id;
    await prisma.productStationLink.create({
      data: { productId: product.id, stationId: grillStationId },
    });

    const pairs: { pass: string; grill: string }[] = [];
    for (let i = 0; i < 7; i += 1) pairs.push(await sendPair(`d174-pair-${i}`));
    const p = pairs.map((x) => x.pass);
    const g = pairs.map((x) => x.grill);

    // Pass: two started, one bumped, four left queued → { 4, 2, 1 }.
    await start(p[0]!);
    await start(p[1]!);
    await bump(p[2]!);
    pass = { queued: p.slice(3), preparing: [p[0]!, p[1]!], doneToday: [p[2]!] };

    // Grill: one started, three bumped today, one bumped and moved out of the
    // day, two left queued → { 2, 1, 3 } with a fourth COMPLETED row the Done
    // chip must not see.
    await start(g[0]!);
    for (const id of [g[1]!, g[2]!, g[3]!, g[4]!]) await bump(id);
    await backdate(g[4]!, 3);
    grill = {
      queued: g.slice(5),
      preparing: [g[0]!],
      doneToday: [g[1]!, g[2]!, g[3]!],
      doneBefore: g[4]!,
    };

    /*
     * The D147-window row: cut on Pass by the ordinary path, then its station
     * removed by hand, exactly as `backdate` makes yesterday — there is no
     * verb for it and there must not be. Asserting it WAS Pass's first is
     * what makes its absence from Pass's numbers below the null's doing, and
     * not a fixture that never routed it.
     */
    const lone = await sendRound();
    expect(lone.status).toBe(201);
    const loneRow = await prisma.kitchenTicket.findFirstOrThrow({
      where: { roundId: lone.data.id },
      select: { id: true, stationId: true },
    });
    expect(loneRow.stationId).toBe(stationId);
    await prisma.kitchenTicket.update({ where: { id: loneRow.id }, data: { stationId: null } });
    stationless = loneRow.id;
  });

  it('?stationId=A returns A’s tickets and A’s three numbers, and the counts route agrees exactly', async () => {
    const stations: { name: string; id: string; lanes: Lanes; expected: LaneCounts }[] = [
      { name: 'Pass', id: stationId, lanes: pass, expected: PASS_COUNTS },
      { name: 'Grill', id: grillStationId, lanes: grill, expected: GRILL_COUNTS },
    ];
    for (const { name, id, lanes, expected } of stations) {
      // The station travels INSIDE every compared value, for the same reason
      // D154 carries the lane: a bare mismatch on the second pass would not
      // say which station produced it.
      const outstanding = await board(`?status=OUTSTANDING&stationId=${id}`);
      expect({ name, status: outstanding.status }).toEqual({ name, status: 200 });
      // POSITIVE — the LIST is that station's slice of the lane: exactly its
      // queued and started tickets, each card naming the station asked for.
      expect({ name, ids: ids(outstanding) }).toEqual({
        name,
        ids: [...lanes.queued, ...lanes.preparing].sort(),
      });
      expect(outstanding.data.items.every((t) => t.stationId === id)).toBe(true);
      // …and the COUNTS are that station's, NAMED — not the branch's, not the
      // other station's, and not a count of the rows just listed (which would
      // put 6 on a chip that must say 4).
      expect({ name, counts: outstanding.data.counts }).toEqual({ name, counts: expected });

      const done = await board(`?status=COMPLETED_TODAY&stationId=${id}`);
      expect({ name, ids: ids(done) }).toEqual({ name, ids: [...lanes.doneToday].sort() });
      expect({ name, counts: done.data.counts }).toEqual({ name, counts: expected });

      // The standalone route, same param: the two exposures pinned to each
      // other under a station cut, as D154 pinned them without one.
      const standalone = await laneCounts(`?stationId=${id}`);
      expect({ name, status: standalone.status }).toEqual({ name, status: 200 });
      expect({ name, counts: standalone.data }).toEqual({ name, counts: expected });
    }

    /*
     * …and the chips partition the lane the way the lists do (D142b, per
     * station): Pass's outstanding cards number 4 + 2, Grill's 2 + 1, and the
     * two slices share no ticket. A chip is a promise about a list; this is
     * the line that reads the promise and the list against each other.
     */
    const passIds = ids(await board(`?status=OUTSTANDING&stationId=${stationId}`));
    const grillIds = ids(await board(`?status=OUTSTANDING&stationId=${grillStationId}`));
    expect(passIds).toHaveLength(PASS_COUNTS.toMake + PASS_COUNTS.preparing);
    expect(grillIds).toHaveLength(GRILL_COUNTS.toMake + GRILL_COUNTS.preparing);
    expect(passIds.filter((id) => grillIds.includes(id))).toEqual([]);
  });

  it('D142’s day bound holds under the station cut, on the lane and on the chip', async () => {
    // POSITIVE — Grill has FOUR completed tickets when the day is not cut…
    const everCompleted = await board(`?status=COMPLETED&stationId=${grillStationId}`);
    expect(ids(everCompleted)).toEqual([...grill.doneToday, grill.doneBefore].sort());
    // …and three on Done, because one finished three days ago.
    const today = await board(`?status=COMPLETED_TODAY&stationId=${grillStationId}`);
    expect(ids(today)).toEqual([...grill.doneToday].sort());
    expect(ids(today)).not.toContain(grill.doneBefore);
    // NEGATIVE — the chip says three, not four, on both exposures: a station-
    // scoped count that had lost the day bound would say 4 here.
    expect(today.data.counts.doneToday).toBe(3);
    expect((await laneCounts(`?stationId=${grillStationId}`)).data.doneToday).toBe(3);
    // …and the branch's Done chip is 4, not 5, for the same reason — the
    // backdated bump is out of the day on every scope.
    expect((await laneCounts()).data.doneToday).toBe(4);
  });

  it('every chip carries its number whichever lane is open — the PO’s Done tab, under a station cut', async () => {
    /*
     * THE REPORT: on Done with a station selected, only the Done chip had a
     * number. The envelope now carries all three, and they must not move with
     * `?status=` — the loop D154 runs for the branch, run for one station. The
     * Cancelled lane is again the sharpest: zero cards, and the chips still
     * say 2/1/3.
     */
    const standalone = (await laneCounts(`?stationId=${grillStationId}`)).data;
    expect(standalone).toEqual(GRILL_COUNTS);

    const lanes = [
      '',
      '?status=OUTSTANDING',
      '?status=COMPLETED_TODAY',
      '?status=COMPLETED',
      '?status=CANCELLED',
    ];
    for (const filter of lanes) {
      const tick = await board(`${filter}${filter ? '&' : '?'}stationId=${grillStationId}`);
      expect({ filter, status: tick.status }).toEqual({ filter, status: 200 });
      expect({ filter, counts: tick.data.counts }).toEqual({ filter, counts: standalone });
    }

    // …and those were different reads: the lane moved with `?status=` even
    // though the chips did not.
    expect((await board(`?status=CANCELLED&stationId=${grillStationId}`)).data.items).toHaveLength(
      0,
    );
    expect(ids(await board(`?status=OUTSTANDING&stationId=${grillStationId}`))).toEqual(
      [...grill.queued, ...grill.preparing].sort(),
    );
    expect(ids(await board(`?status=COMPLETED_TODAY&stationId=${grillStationId}`))).toEqual(
      [...grill.doneToday].sort(),
    );
    // Standing on Done, pinned to Grill: the To make and Preparing chips —
    // the ones D152 blanked — carry Grill's 2 and 1, not null and not the
    // branch's 7 and 3.
    const onDone = (await board(`?status=COMPLETED_TODAY&stationId=${grillStationId}`)).data.counts;
    expect(onDone.toMake).toBe(2);
    expect(onDone.preparing).toBe(1);
    expect(onDone).not.toEqual(BRANCH_COUNTS);
  });

  it('omitted, both exposures answer the branch: each station’s numbers plus the ticket on no station', async () => {
    /*
     * The pre-D174 read, byte-for-byte: the existing D142b and D154 tests
     * pin its numbers for their own fixtures and keep passing unchanged. What
     * is added here is the ARITHMETIC — the branch's three numbers are the
     * two stations' three numbers plus the one ticket that belongs to
     * neither, lane by lane, read from the server rather than typed in.
     */
    const branch = (await laneCounts()).data;
    expect(branch).toEqual(BRANCH_COUNTS);
    expect((await board()).data.counts).toEqual(BRANCH_COUNTS);
    // An empty `?stationId=` is omitted, the way a blank search is: a client
    // that sent the key with nothing in it asked for the branch, not for a
    // station named '' — which would otherwise answer three zeroes.
    expect((await board('?stationId=')).data.counts).toEqual(BRANCH_COUNTS);
    expect((await laneCounts('?stationId=')).data).toEqual(BRANCH_COUNTS);

    const passRead = (await laneCounts(`?stationId=${stationId}`)).data;
    const grillRead = (await laneCounts(`?stationId=${grillStationId}`)).data;
    expect(branch).toEqual({
      toMake: passRead.toMake + grillRead.toMake + 1, // + the ticket on no station
      preparing: passRead.preparing + grillRead.preparing,
      doneToday: passRead.doneToday + grillRead.doneToday,
    });

    /*
     * The D147-window ticket: on the branch's lane, on NEITHER station's.
     * A ticket cut during that window carries a null `stationId`; equality
     * matches nothing null, so it is in no station's list or count and only
     * in the "All stations" numbers. That is the truth about the row, not a
     * gap: inventing a station for it is the backfill D152 declined to write.
     */
    const branchLane = await board('?status=OUTSTANDING');
    expect(ids(branchLane)).toContain(stationless);
    expect(ids(branchLane)).toHaveLength(10); // 4 + 2 Pass, 2 + 1 Grill, and it
    expect(ids(await board(`?status=OUTSTANDING&stationId=${stationId}`))).not.toContain(
      stationless,
    );
    expect(ids(await board(`?status=OUTSTANDING&stationId=${grillStationId}`))).not.toContain(
      stationless,
    );
    // POSITIVE CONTROL — the row really carries no station and is really
    // queued, on the wire and in the column: the exclusions above are the
    // null's doing and not a lane's. (That it WAS Pass's is asserted in the
    // fixture, before the null is written.)
    const card = branchLane.data.items.find((t) => t.id === stationless)!;
    expect({
      stationId: card.stationId,
      stationName: card.stationName,
      status: card.status,
    }).toEqual({ stationId: null, stationName: null, status: 'QUEUED' });
    const row = await prisma.kitchenTicket.findUniqueOrThrow({
      where: { id: stationless },
      select: { stationId: true, status: true },
    });
    expect(row).toEqual({ stationId: null, status: 'QUEUED' });
  });

  it('a station the branch does not have answers empty and zero on both routes — not 400', async () => {
    /*
     * A board whose selected station was archived mid-shift keeps polling
     * with its id. Empty lists and three zeroes are the truth about that
     * station here; a 400 would be an error the board cannot recover from
     * without a reload, which is why the DTO bounds the string and checks it
     * against nothing.
     */
    const tick = await board('?status=OUTSTANDING&stationId=no-such-station');
    expect(tick.status).toBe(200);
    expect(tick.data.items).toEqual([]);
    expect(tick.data.counts).toEqual(NOTHING);
    const standalone = await laneCounts('?stationId=no-such-station');
    expect(standalone.status).toBe(200);
    expect(standalone.data).toEqual(NOTHING);
    // POSITIVE CONTROL — the same lane, unpinned, has ten cards and the
    // branch's numbers: the empties above are the station's, not the branch's.
    const unpinned = await board('?status=OUTSTANDING');
    expect(unpinned.data.items).toHaveLength(10);
    expect(unpinned.data.counts).toEqual(BRANCH_COUNTS);
  });
});

/*
 * D175 — station and table are STRUCTURED filters on the history, and the
 * search keeps the three things a person would type.
 *
 * Until now the search box had five OR legs on the server — ticket number,
 * order number, table/tab/area, station name, item name — and "grill" typed
 * into it found the grill's tickets AND every Grilled Seer Fish the pass had
 * ever cooked. The PO asked for a Filters button instead: a multi-select for
 * the station and one for the table, each a SET of ids. A ticket is on the
 * page when its station is IN the station set AND its session's table is IN
 * the table set; an empty set is no filter on that axis. A takeaway ticket
 * has no table and matches only while the table axis is unfiltered.
 *
 * The unit spec pins the emitted `where`. What only rows can prove is that the
 * two axes really are AND-ed across and OR-ed within, that the table clause
 * really reaches through the SESSION (a ticket carries no table of its own),
 * and that the two retired legs are gone from the wire — so this fixture is
 * arranged for every query below to answer a DIFFERENT set of ids:
 *
 *   A  Pass    T7   round 1        D  Pastry  T8   round 2
 *   B  Grill   T7   round 1        E  Pass    takeaway
 *   C  Pass    T8   round 2        F  (none)  T7   round 3, stationId nulled
 *
 * F is the D147-window shape again: on a table, on no station, so the two
 * axes can be told apart — the table set finds it, and the union of EVERY
 * station in the branch does not. And every set assertion is on ids, never on
 * a total alone: a total of 3 is satisfied by three wrong tickets.
 */
describe('D175 — the history’s structured filters', () => {
  let grillStationId: string;
  let pastryStationId: string;
  let grillProductId: string;
  let pastryProductId: string;
  let t7: string;
  let t8: string;
  /** T8's open order — called off in the table test to prove D115 holds under a table set. */
  let order2Id: string;
  let A: string;
  let B: string;
  let C: string;
  let D: string;
  let E: string;
  let F: string;

  /** One page of the history, with the query inside the status assertion. */
  const page = async (query: string) => {
    const res = await history(query);
    expect({ query, status: res.status }).toEqual({ query, status: 200 });
    return res.data;
  };
  /** The ids on a page, order-free: the D150 ordering is pinned elsewhere. */
  const idsOf = async (query: string) => [...(await page(query)).items.map((t) => t.id)].sort();
  const set = (...ticketIds: string[]) => [...ticketIds].sort();

  beforeEach(async () => {
    const mkStation = async (code: string, name: string) =>
      (
        await prisma.kitchenStation.create({
          data: { tenantId: restaurant.tenantId, branchId, code, name },
        })
      ).id;
    const mkProduct = async (name: string, sku: string, station: string) => {
      const product = await prisma.product.create({
        data: {
          tenantId: restaurant.tenantId,
          name,
          type: 'Inventory',
          sku,
          unitPrice: '900.00',
          quantityOnHand: '100.000',
          isActive: true,
        },
      });
      await prisma.productStationLink.create({
        data: { productId: product.id, stationId: station },
      });
      return product.id;
    };
    grillStationId = await mkStation('GRILL', 'Grill');
    pastryStationId = await mkStation('PASTRY', 'Pastry');
    grillProductId = await mkProduct('Grilled Seer Fish', 'RST-SEER', grillStationId);
    pastryProductId = await mkProduct('Watalappan', 'RST-WATA', pastryStationId);

    /*
     * T7 is the outer fixture's table and `orderId` its open order. T8 sits
     * in the SAME area, so 'terrace' would have matched every dine-in ticket
     * here through the retired leg — the sharpest zero available for it.
     */
    const terrace = await prisma.diningArea.findFirstOrThrow({
      where: { branchId, name: 'Terrace' },
      select: { id: true },
    });
    t7 = (
      await prisma.restaurantTable.findFirstOrThrow({
        where: { branchId, code: 'T7' },
        select: { id: true },
      })
    ).id;
    t8 = (
      await prisma.restaurantTable.create({
        data: {
          tenantId: restaurant.tenantId,
          branchId,
          areaId: terrace.id,
          code: 'T8',
          capacity: 2,
        },
      })
    ).id;
    const session2 = await http.request<{ id: string }>(
      'POST',
      `/restaurant/branches/${branchId}/table-sessions`,
      { token: ownerToken(), body: { tableId: t8 } },
    );
    expect(session2.status).toBe(201);
    const order2 = await http.request<{ id: string }>(
      'POST',
      `/restaurant/table-sessions/${session2.data.id}/orders`,
      { token: ownerToken() },
    );
    expect(order2.status).toBe(201);
    order2Id = order2.data.id;

    /** Send a round and hand back its tickets keyed by the station that cut them. */
    const send = async (
      order: string,
      key: string,
      items: { productId: string; quantity: string }[],
    ) => {
      const sent = await http.request<{ id: string }>(
        'POST',
        `/restaurant/orders/${order}/rounds`,
        {
          token: ownerToken(),
          body: { idempotencyKey: key, items: items.map((i) => ({ sourceKind: 'PRODUCT', ...i })) },
        },
      );
      expect(sent.status).toBe(201);
      const rows = await prisma.kitchenTicket.findMany({
        where: { roundId: sent.data.id },
        select: { id: true, stationId: true },
      });
      // One dish per station per round, so D152's split is one ticket per
      // line — checked here so a fixture that lost one fails as a fixture.
      expect(rows).toHaveLength(items.length);
      return new Map(rows.map((r) => [r.stationId, r.id]));
    };
    const round1 = await send(orderId, 'd175-r1', [
      { productId, quantity: '1' }, // Beef Steak → Pass
      { productId: grillProductId, quantity: '1' }, // → Grill
    ]);
    A = round1.get(stationId)!;
    B = round1.get(grillStationId)!;
    const round2 = await send(order2.data.id, 'd175-r2', [
      { productId, quantity: '1' }, // Beef Steak → Pass
      { productId: pastryProductId, quantity: '1' }, // → Pastry
    ]);
    C = round2.get(stationId)!;
    D = round2.get(pastryStationId)!;

    // E — a takeaway, through the real route, so its session hangs off
    // whatever the takeaway path gives it and not off a table this spec chose.
    const takeaway = await http.request<{ id: string; orderId: string }>(
      'POST',
      `/restaurant/takeaway`,
      {
        token: ownerToken(),
        body: {
          branchId,
          idempotencyKey: 'd175-takeaway',
          items: [{ sourceKind: 'PRODUCT', productId, quantity: 1 }],
        },
      },
    );
    expect(takeaway.status).toBe(201);
    E = (
      await prisma.kitchenTicket.findFirstOrThrow({
        where: { round: { orderId: takeaway.data.orderId } },
        select: { id: true },
      })
    ).id;

    // F — cut on Pass, at T7, then its station removed by hand: the D147
    // window's shape, made the way `backdate` makes yesterday.
    const round3 = await send(orderId, 'd175-r3', [{ productId, quantity: '1' }]);
    F = round3.get(stationId)!;
    await prisma.kitchenTicket.update({ where: { id: F }, data: { stationId: null } });
  });

  it('with no filter set, reads all six — the set the assertions below carve up', async () => {
    const all = await page('');
    expect(set(...all.items.map((t) => t.id))).toEqual(set(A, B, C, D, E, F));
    expect(all.total).toBe(6);
    /*
     * The facts every filter below turns on, read off the WIRE rather than
     * assumed from the fixture: which station each was cut on, which table
     * each sits at, that E is the takeaway, and that F is on no station.
     */
    const byId = new Map(all.items.map((t) => [t.id, t]));
    const shape = (id: string) => {
      const t = byId.get(id)!;
      return { station: t.stationName, place: t.placeLabel };
    };
    expect(shape(A)).toEqual({ station: 'Pass', place: 'T7 · Terrace' });
    expect(shape(B)).toEqual({ station: 'Grill', place: 'T7 · Terrace' });
    expect(shape(C)).toEqual({ station: 'Pass', place: 'T8 · Terrace' });
    expect(shape(D)).toEqual({ station: 'Pastry', place: 'T8 · Terrace' });
    expect(shape(E)).toEqual({ station: 'Pass', place: 'Takeaway' });
    expect(shape(F)).toEqual({ station: null, place: 'T7 · Terrace' });
    expect(byId.get(F)!.stationId).toBeNull();
  });

  it('?stationId=a&stationId=b is the union on the station axis, and no station’s set holds a D147-window ticket', async () => {
    // POSITIVE — one station, then another, then both: the sets, not the totals.
    expect(await idsOf(`?stationId=${stationId}`)).toEqual(set(A, C, E));
    expect(await idsOf(`?stationId=${grillStationId}`)).toEqual(set(B));
    expect(await idsOf(`?stationId=${stationId}&stationId=${grillStationId}`)).toEqual(
      set(A, B, C, E),
    );
    // …and the total is of the filtered set, so the pager cannot promise a
    // page of the branch's tickets over a page of the station's.
    expect((await page(`?stationId=${stationId}`)).total).toBe(3);

    /*
     * NEGATIVE — the union of EVERY station the branch has is still not the
     * whole list: F belongs to none of them. `IN` never matches null, so a
     * ticket cut during the D147 window is in no station's set and only on
     * the unfiltered page — the same truth D174 states for the lane counts.
     * "Every station" is checked rather than assumed: the four ids below are
     * the branch's whole station table, Main (created by the submits) included.
     */
    const main = await prisma.kitchenStation.findFirstOrThrow({
      where: { branchId, code: 'MAIN' },
      select: { id: true },
    });
    expect(
      (await prisma.kitchenStation.findMany({ where: { branchId }, select: { id: true } }))
        .map((s) => s.id)
        .sort(),
    ).toEqual(set(stationId, grillStationId, pastryStationId, main.id));
    const everyStation = [stationId, grillStationId, pastryStationId, main.id]
      .map((id) => `stationId=${id}`)
      .join('&');
    expect(await idsOf(`?${everyStation}`)).toEqual(set(A, B, C, D, E));
    // POSITIVE CONTROL — F is on the unfiltered page, so the line above is an
    // exclusion and not a lost row; and it was cut on the Pass dish, so its
    // absence from Pass's set is the null's doing.
    expect(await idsOf('')).toContain(F);
    const f = await prisma.kitchenTicket.findUniqueOrThrow({
      where: { id: F },
      select: { stationId: true, items: { select: { menuItemName: true } } },
    });
    expect(f).toEqual({ stationId: null, items: [{ menuItemName: 'Beef Steak' }] });
  });

  it('?tableId=x narrows to the session’s table, and a takeaway ticket is on no table', async () => {
    // POSITIVE — one table, the other, then both: F is on T7 despite having
    // no station, which is what makes the two axes independent — a build
    // that keyed the table off the station join would lose it here.
    expect(await idsOf(`?tableId=${t7}`)).toEqual(set(A, B, F));
    expect(await idsOf(`?tableId=${t8}`)).toEqual(set(C, D));
    expect(await idsOf(`?tableId=${t7}&tableId=${t8}`)).toEqual(set(A, B, C, D, F));
    expect((await page(`?tableId=${t7}`)).total).toBe(3);

    /*
     * NEGATIVE — E, the takeaway, is in neither table's set nor in the set
     * holding both of the floor's tables. D175: a takeaway ticket has no
     * table and matches only while the table axis is unfiltered. Paired with
     * the unfiltered read that has it AND names it as the takeaway, so this
     * is an exclusion of a real ticket and not a fixture that never made one.
     *
     * Honest about the rows: a takeaway's session hangs off the branch's
     * synthetic WALK-IN table (D92), so what "no table" means on the wire is
     * that no table a person would PICK admits it. The sets here hold the
     * floor's real tables; whether the walk-in row is ever offered as a chip
     * is the picker's decision, and this spec pins neither answer to it.
     */
    const all = await page('');
    expect(all.items.map((t) => t.id)).toContain(E);
    expect(all.items.find((t) => t.id === E)!.placeLabel).toBe('Takeaway');
    expect(all.total).toBe(6);

    /*
     * D115 UNDER the table filter. The clause reaches the session through the
     * SAME `round.order` object the cancellation clauses live in; written as a
     * second `round:` key it would have silently replaced them, and a called-
     * off order's tickets would come back the moment a table was picked. So
     * T8's order is called off here — by hand, as the D142 tests do it — and
     * T8's set is asserted EMPTY, with the {C, D} read above as the positive
     * control that the filter found them a moment ago.
     */
    await prisma.restaurantOrder.update({
      where: { id: order2Id },
      data: { status: 'CANCELLED' },
    });
    expect(await idsOf(`?tableId=${t8}`)).toEqual([]);
    expect(await idsOf(`?tableId=${t7}&tableId=${t8}`)).toEqual(set(A, B, F));
    // …and out of the unfiltered page too, so this is D115 holding rather
    // than a table filter that lost T8.
    expect(await idsOf('')).toEqual(set(A, B, E, F));
  });

  it('both sets together intersect: AND across the axes, OR within one', async () => {
    // POSITIVE — Pass ∩ T7: A alone (C and E are Pass's elsewhere; B and F
    // are T7's on other stations).
    expect(await idsOf(`?stationId=${stationId}&tableId=${t7}`)).toEqual(set(A));
    // NEGATIVE — Grill ∩ T8 is EMPTY. An OR across the axes would answer
    // {B, C, D} here; this is the assertion that tells AND from OR.
    const none = await page(`?stationId=${grillStationId}&tableId=${t8}`);
    expect(none.items).toEqual([]);
    expect(none.total).toBe(0);
    // POSITIVE CONTROLS for that empty page — each axis alone is non-empty,
    // so the empty is the intersection's and not a broken filter's.
    expect(await idsOf(`?stationId=${grillStationId}`)).toEqual(set(B));
    expect(await idsOf(`?tableId=${t8}`)).toEqual(set(C, D));
    // OR within an axis, AND across: {Pass, Grill} ∩ T7 = {A, B}; Pass ∩
    // {T7, T8} = {A, C} — E (Pass, no table) and F (T7, no station) both
    // drop, each on the axis it has no value for.
    expect(
      await idsOf(`?stationId=${stationId}&stationId=${grillStationId}&tableId=${t7}`),
    ).toEqual(set(A, B));
    expect(await idsOf(`?stationId=${stationId}&tableId=${t7}&tableId=${t8}`)).toEqual(set(A, C));
  });

  it('the search lost its station and table legs, and kept the KOT, the RO and the dish', async () => {
    const all = await page('');
    const d = all.items.find((t) => t.id === D)!;
    const a = all.items.find((t) => t.id === A)!;

    // POSITIVE — the three legs that stay, each reaching D through a
    // different field. The RO number is the ORDER's, so it finds both
    // tickets of round 2 — the order is what a person types it to find.
    expect(await idsOf('?search=watalappan')).toEqual(set(D));
    expect(await idsOf(`?search=${encodeURIComponent(d.ticketNumber)}`)).toEqual(set(D));
    expect(await idsOf(`?search=${encodeURIComponent(d.orderNumber!)}`)).toEqual(set(C, D));

    /*
     * NEGATIVE — the STATION leg. 'pastry' is D's own station name, on the
     * row the unfiltered read returns, and it matches no KOT number, no RO
     * number and no dish; through the D152 leg this found D. Now the station
     * is a filter, which is the positive paired with the zero.
     */
    expect(d.stationName).toBe('Pastry');
    expect((await page('?search=pastry')).total).toBe(0);
    expect(await idsOf(`?stationId=${pastryStationId}`)).toEqual(set(D));

    /*
     * NEGATIVE — the TABLE/tab/area leg. 'T7' and 'terrace' are on the place
     * label of five tickets here and neither finds anything now; `?tableId=`
     * is the way in, and it finds the three at T7.
     */
    expect(a.placeLabel).toBe('T7 · Terrace');
    expect((await page('?search=T7')).total).toBe(0);
    expect((await page('?search=terrace')).total).toBe(0);
    expect(await idsOf(`?tableId=${t7}`)).toEqual(set(A, B, F));

    // NEGATIVE — and nothing else grew a leg: a term on no field is nothing.
    expect((await page('?search=zzzznotathing')).total).toBe(0);
  });

  it('composes with the search, and pages the filtered set with its own total', async () => {
    // Search alone finds every Beef Steak; the filters narrow it to the one
    // at T8 — the search did not do the narrowing, and the filters did not
    // do the finding.
    expect(await idsOf('?search=beef')).toEqual(set(A, C, E, F));
    expect(await idsOf(`?search=beef&stationId=${stationId}&tableId=${t8}`)).toEqual(set(C));

    // Paging over a filtered set: the total is the SET's, the pages neither
    // overlap nor drop a row, and page 1 is what the client resets to on a
    // filter change — a count over the branch would promise a third page.
    const first = await page(`?tableId=${t7}&page=1&pageSize=2`);
    expect(first.items).toHaveLength(2);
    expect(first.total).toBe(3);
    const second = await page(`?tableId=${t7}&page=2&pageSize=2`);
    expect(second.items).toHaveLength(1);
    expect(set(...first.items.map((t) => t.id), ...second.items.map((t) => t.id))).toEqual(
      set(A, B, F),
    );
  });
});
