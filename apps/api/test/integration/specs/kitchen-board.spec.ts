/**
 * D68 — the kitchen board replaces the kitchen printer.
 *
 * What this covers is the whole delivery path: a waiter sends a round, and
 * the food appears on a screen somebody is rostered to. There is no printer
 * behind it, which is the point — so the assertions are about the ROW being
 * complete and reachable, and about who is allowed to touch it.
 *
 * D174 brought unattended printing back as a COPY of the board, and this
 * spec's fixture configures no printer on purpose: the board must be whole
 * with nothing to print to. The "no print work" negatives below therefore
 * still hold, now as the proof that a branch without a printer enqueues
 * nothing and loses nothing. The positive side — a configured printer gets
 * its attempt and the board is untouched by it — lives in
 * `auto-printing.spec.ts`.
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
 * see the last test in this file.
 */
const laneCounts = () =>
  http.request<LaneCounts>(
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
   * D152 — this link ROUTES again. It stayed in the fixture through the D147
   * window (where the tests asserted it was present and ignored), so the
   * assertions that now read 'Pass' off a card are reading the effect of a
   * link this fixture really makes — not a default, and not the Main
   * fallback, which would have said 'Main'.
   */
  await prisma.productStationLink.create({ data: { productId: product.id, stationId } });
});

describe('D68 — a sent round lands on the kitchen board', () => {
  it('creates a ticket carrying where the food is going, and — with no printer configured — queues no print work', async () => {
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

    // NEGATIVE — nothing was queued for a printer, because this branch has
    // none (D174: no printer means no attempt, and the ticket is still whole).
    // Paired with the positives above: this cannot pass by virtue of no
    // ticket having been generated.
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

  it('searches the ticket number and the dish, and narrows rather than empties', async () => {
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
     * D152 — and a fourth way in: the STATION that cooked it. This leg left
     * the search with the split and comes back with it, and it is the one that
     * answers "what did the grill have on last Friday". 'pass' matches no KOT
     * number, no RO number, no dish name and no part of "T7 · Terrace", so a
     * hit here can only have come through the station join.
     */
    expect((await history('?search=pass')).data.total).toBe(1);
    /*
     * NEGATIVE, paired — 'main' is a station this branch really HAS (the
     * submit created it) and it did not cook this ticket. Without this the
     * positive above would also hold for a leg that matched any station in the
     * branch rather than the ticket's own.
     */
    expect(await prisma.kitchenStation.count({ where: { branchId, code: 'MAIN' } })).toBe(1);
    expect((await history('?search=main')).data.total).toBe(0);
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
