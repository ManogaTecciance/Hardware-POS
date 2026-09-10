import { Prisma } from '@hardware-pos/database';

import { KitchenService } from './kitchen.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { SettingsService } from '../settings/settings.service';

/**
 * D147 — a round is ONE kitchen ticket, holding every item of it.
 *
 * Two claims, and the second is the one that made this urgent:
 *
 * - A round produces exactly ONE ticket. It used to produce one per KITCHEN
 *   STATION its items routed to, so a single order for a single round arrived
 *   on the board as several separate cards (RO-000026, one round of 15 lines,
 *   became KOT-000027 with 13 and KOT-000028 with 2).
 * - An item with NO station link now reaches the ticket. The old routing
 *   DROPPED it unless the branch happened to have exactly one active station
 *   (D67's fallback), and the affected branch has four — so an unlinked dish
 *   reached the kitchen board on no ticket at all: ordered, billed, never
 *   cooked. Since the only place to link a dish to a station is a wizard step
 *   that renders empty when no branch is selected, "unlinked" is the normal
 *   case, not the exceptional one.
 *
 * The fixture is deliberately hostile to both claims: its round carries items
 * that WOULD have routed to two different stations plus one that would have
 * routed to none, at a four-station branch. "One ticket" therefore cannot be
 * an artefact of a fixture with nothing to split — and the mutation proof at
 * the end runs the old grouping against the same stub to show that the
 * assertions here genuinely reject it.
 *
 * Prisma is a stub: the assertions are about the WRITES the service issues.
 * What the database does with them is pinned by the integration suite.
 */

const TENANT = 'tnt_1';
const BRANCH = 'brn_1';
const ROUND = 'rnd_1';

// The four stations the affected branch really has. Their only role here is
// to be MORE THAN ONE: with a single active station the old code's fallback
// would have caught the unlinked item, and the defect would not reproduce.
const BRANCH_STATIONS = [
  { id: 'stn_bar', name: 'Bar' },
  { id: 'stn_grill', name: 'Grill' },
  { id: 'stn_main', name: 'Main Kitchen' },
  { id: 'stn_pastry', name: 'Pastry' },
];

/** Station links that WOULD have split this round — 'prd_pudding' has none. */
const PRODUCT_LINKS = [
  { productId: 'prd_wings', stationId: 'stn_grill' },
  { productId: 'prd_seer', stationId: 'stn_grill' },
  { productId: 'prd_rice', stationId: 'stn_main' },
];

type RoundItem = {
  id: string;
  menuItemId: string;
  productId: string | null;
  menuItemName: string;
  quantity: Prisma.Decimal;
  specialInstructions: string | null;
  variantNameSnapshot: string | null;
  modifiers: { optionName: string }[];
};

function item(
  id: string,
  productId: string,
  menuItemName: string,
  extra: Partial<RoundItem> = {},
): RoundItem {
  return {
    id,
    menuItemId: `mi_${id}`,
    productId,
    menuItemName,
    quantity: new Prisma.Decimal(1),
    specialInstructions: null,
    variantNameSnapshot: null,
    modifiers: [],
    ...extra,
  };
}

/**
 * The round the product owner reported, in miniature: two dishes for the
 * grill, one for the main kitchen, and one linked to nothing at all.
 */
const ROUND_ITEMS: RoundItem[] = [
  item('itm_1', 'prd_wings', 'Chicken Wings', {
    quantity: new Prisma.Decimal(2),
    modifiers: [{ optionName: 'Extra spicy' }],
  }),
  item('itm_2', 'prd_rice', 'Fried Rice', {
    variantNameSnapshot: 'LARGE',
    specialInstructions: 'No egg',
  }),
  item('itm_3', 'prd_seer', 'Grilled Seer Fish'),
  item('itm_4', 'prd_pudding', 'Watalappan'),
];

const ALL_NAMES = ['Chicken Wings', 'Fried Rice', 'Grilled Seer Fish', 'Watalappan'];
/** The item the old routing dropped: no station link, four-station branch. */
const UNLINKED_NAME = 'Watalappan';

type CreatedTicket = { id: string; stationId: string | null; ticketNumber: string };
type WrittenItem = {
  ticketId: string;
  menuItemName: string;
  variantName: string | null;
  quantity: Prisma.Decimal;
  modifierNames: string[];
  specialInstructions: string | null;
};

type Harness = {
  service: KitchenService;
  tx: Prisma.TransactionClient;
  raw: {
    restaurantOrderItem: { findMany: jest.Mock };
    menuItemStationLink: { findMany: jest.Mock };
    productStationLink: { findMany: jest.Mock };
    kitchenStation: { findMany: jest.Mock };
    $queryRaw: jest.Mock;
  };
  created: CreatedTicket[];
  written: WrittenItem[];
};

function makeHarness(items: RoundItem[] = ROUND_ITEMS): Harness {
  const created: CreatedTicket[] = [];
  const written: WrittenItem[] = [];
  let seq = 27;

  const raw = {
    restaurantOrderItem: { findMany: jest.fn().mockResolvedValue(items) },
    /*
     * The junctions and the station catalogue SURVIVE D147 — the schema, the
     * wizard multi-select and the station screens all still exist. They are
     * stubbed with real-looking data on purpose: a test that stubbed them
     * empty would pass for a service that still consulted them, because an
     * empty junction and an unconsulted one look identical from here (D30).
     */
    menuItemStationLink: { findMany: jest.fn().mockResolvedValue([]) },
    productStationLink: { findMany: jest.fn().mockResolvedValue(PRODUCT_LINKS) },
    kitchenStation: { findMany: jest.fn().mockResolvedValue(BRANCH_STATIONS) },
    // `nextDocumentNumber` is a raw INSERT … RETURNING; one call, one number.
    $queryRaw: jest.fn().mockImplementation(() => Promise.resolve([{ value: seq++ }])),
  };

  const tx = {
    ...raw,
    kitchenTicket: {
      create: jest.fn().mockImplementation((args: { data: Record<string, unknown> }) => {
        const row: CreatedTicket = {
          id: `tkt_${created.length + 1}`,
          stationId: (args.data.stationId as string | null) ?? null,
          ticketNumber: args.data.ticketNumber as string,
        };
        created.push(row);
        return Promise.resolve(row);
      }),
    },
    kitchenTicketItem: {
      create: jest.fn().mockImplementation((args: { data: Record<string, unknown> }) => {
        written.push(args.data as unknown as WrittenItem);
        return Promise.resolve(undefined);
      }),
    },
  };

  const prisma = {} as unknown as PrismaService;
  const settings = {
    getSettings: () => ({ timezone: 'Asia/Colombo' }),
  } as unknown as SettingsService;

  return {
    service: new KitchenService(prisma, settings),
    tx: tx as unknown as Prisma.TransactionClient,
    raw,
    created,
    written,
  };
}

/**
 * D147's contract, in one place, so the mutation proof at the bottom is run
 * against exactly the check every test above rests on. If this ever stops
 * distinguishing one ticket from several, the proof fails and says so.
 */
function assertOneTicketCarryingEveryItem(
  created: CreatedTicket[],
  written: WrittenItem[],
  expectedNames: string[],
): void {
  expect(created).toHaveLength(1);
  const ticket = created[0]!;
  // The ticket belongs to no station — the positive form of "the split is gone".
  expect(ticket.stationId).toBeNull();
  // Every item, on THAT ticket, in the round's own order…
  expect(written.filter((w) => w.ticketId === ticket.id).map((w) => w.menuItemName)).toEqual(
    expectedNames,
  );
  // …and nothing written anywhere else, so a second ticket cannot hide here.
  expect(written).toHaveLength(expectedNames.length);
}

describe('KitchenService.generateTicketForRound (D147)', () => {
  it('a round whose items span several stations still yields exactly ONE ticket, carrying all of them', async () => {
    const h = makeHarness();

    const ticketId = await h.service.generateTicketForRound(h.tx, TENANT, BRANCH, ROUND);

    assertOneTicketCarryingEveryItem(h.created, h.written, ALL_NAMES);
    expect(ticketId).toBe(h.created[0]!.id);
    // One round, one KOT number — not one per station.
    expect(h.raw.$queryRaw).toHaveBeenCalledTimes(1);
    expect(h.created[0]!.ticketNumber).toBe('KOT-000027');
  });

  it('an item with NO station link at a multi-station branch now reaches the ticket', async () => {
    /*
     * The defect this decision fixes, stated on its own because it is the one
     * with money attached: under the old routing 'Watalappan' had no link and
     * the branch had four stations, so D67's single-station fallback did not
     * apply and the line reached the board on NO ticket — cooked by nobody,
     * while the guest was billed for it.
     */
    const h = makeHarness();

    await h.service.generateTicketForRound(h.tx, TENANT, BRANCH, ROUND);

    const names = h.written.map((w) => w.menuItemName);
    expect(names).toContain(UNLINKED_NAME);
    // POSITIVE both ways: the linked items are still there too, so this did
    // not pass by the ticket having become "all items" in name only.
    expect(names).toEqual(ALL_NAMES);
    // And the branch really did have more than one station to choose between —
    // with one, the old code would have routed it and there'd be no defect.
    expect(BRANCH_STATIONS.length).toBeGreaterThan(1);
  });

  it('NEGATIVE — it never consults the station links or the station catalogue', async () => {
    const h = makeHarness();

    await h.service.generateTicketForRound(h.tx, TENANT, BRANCH, ROUND);

    // POSITIVE — the round's items ARE read, so "no queries" is not why the
    // three below are unqueried.
    expect(h.raw.restaurantOrderItem.findMany).toHaveBeenCalledTimes(1);
    // NEGATIVE — and routing is not consulted, even though the stubs above
    // would have answered with data that splits this round in two.
    expect(h.raw.productStationLink.findMany).not.toHaveBeenCalled();
    expect(h.raw.menuItemStationLink.findMany).not.toHaveBeenCalled();
    expect(h.raw.kitchenStation.findMany).not.toHaveBeenCalled();
  });

  it('does not even ask the database for the routing inputs', async () => {
    const h = makeHarness();

    await h.service.generateTicketForRound(h.tx, TENANT, BRANCH, ROUND);

    const args = h.raw.restaurantOrderItem.findMany.mock.calls[0]![0] as {
      where: Record<string, unknown>;
      select: Record<string, unknown>;
      orderBy: unknown;
    };
    expect(args.where).toEqual({ tenantId: TENANT, roundId: ROUND });
    // POSITIVE — exactly what a ticket line needs, D46's variant included.
    expect(Object.keys(args.select).sort()).toEqual([
      'menuItemName',
      'modifiers',
      'quantity',
      'specialInstructions',
      'variantNameSnapshot',
    ]);
    // NEGATIVE — and none of the three columns routing used to key off.
    expect(args.select.productId).toBeUndefined();
    expect(args.select.menuItemId).toBeUndefined();
    expect(args.select.sourceKind).toBeUndefined();
  });

  it('writes the items in the round’s own order, with a tiebreak that makes it total', async () => {
    const h = makeHarness();

    await h.service.generateTicketForRound(h.tx, TENANT, BRANCH, ROUND);

    const args = h.raw.restaurantOrderItem.findMany.mock.calls[0]![0] as { orderBy: unknown };
    /*
     * `createdAt` alone would not do it: a round's items are written inside
     * one transaction, so Postgres stamps them all with the same instant and
     * two lines could swap places between two reads of the same ticket.
     */
    expect(args.orderBy).toEqual([{ createdAt: 'asc' }, { id: 'asc' }]);
    // The order that came back is the order that was written.
    expect(h.written.map((w) => w.menuItemName)).toEqual(ALL_NAMES);
  });

  it('carries the D46 variant snapshot, the modifier names and the instructions verbatim', async () => {
    const h = makeHarness();

    await h.service.generateTicketForRound(h.tx, TENANT, BRANCH, ROUND);

    const wings = h.written.find((w) => w.menuItemName === 'Chicken Wings')!;
    expect(wings.quantity).toEqual(new Prisma.Decimal(2));
    expect(wings.modifierNames).toEqual(['Extra spicy']);
    expect(wings.variantName).toBeNull();

    const rice = h.written.find((w) => w.menuItemName === 'Fried Rice')!;
    // D46 — the operator's selection, printed as chosen. The kitchen must not
    // infer the variant from selling price, so a lost snapshot is a wrong dish.
    expect(rice.variantName).toBe('LARGE');
    expect(rice.specialInstructions).toBe('No egg');
  });

  it('a round with no items writes nothing at all and returns null', async () => {
    const h = makeHarness([]);

    const ticketId = await h.service.generateTicketForRound(h.tx, TENANT, BRANCH, ROUND);

    expect(ticketId).toBeNull();
    expect(h.created).toEqual([]);
    expect(h.written).toEqual([]);
    // An empty round must not burn a KOT number either — the sequence has no
    // gaps to spare and the pass has no card to show.
    expect(h.raw.$queryRaw).not.toHaveBeenCalled();
  });

  it('MUTATION PROOF — restoring the per-station split turns these assertions red', async () => {
    /*
     * The mutant is the code that shipped before D147: group the round's items
     * by their ProductStationLink rows, fall back to the branch's sole active
     * station (there isn't one — four stations), drop whatever routes nowhere,
     * and cut a ticket per group. It is run against the SAME stub and read
     * through the SAME assertion the tests above rest on, so this proves the
     * assertion discriminates rather than merely passing.
     */
    const shipped = makeHarness();
    await shipped.service.generateTicketForRound(shipped.tx, TENANT, BRANCH, ROUND);
    // The shipped code satisfies the tripwire…
    assertOneTicketCarryingEveryItem(shipped.created, shipped.written, ALL_NAMES);

    const mutant = makeHarness();
    await perStationSplitMutant(mutant, TENANT, BRANCH, ROUND);

    // …the mutant genuinely reproduces the old behaviour — two cards for one
    // round, and the unlinked dish on neither…
    expect(mutant.created).toHaveLength(2);
    expect(mutant.created.map((t) => t.stationId).sort()).toEqual(['stn_grill', 'stn_main']);
    expect(mutant.written.map((w) => w.menuItemName)).not.toContain(UNLINKED_NAME);
    // …and every leg of the tripwire rejects it.
    expect(() =>
      assertOneTicketCarryingEveryItem(mutant.created, mutant.written, ALL_NAMES),
    ).toThrow();
    expect(() => expect(mutant.created[0]!.stationId).toBeNull()).toThrow();
    expect(() => expect(mutant.written.map((w) => w.menuItemName)).toEqual(ALL_NAMES)).toThrow();
  });
});

/**
 * The pre-D147 routing, reimplemented here and NOWHERE ELSE, purely so the
 * mutation proof above has something real to reject. It writes through the
 * harness's own stub, so what it produces is read exactly as the shipped
 * service's output is.
 */
async function perStationSplitMutant(
  h: Harness,
  tenantId: string,
  branchId: string,
  roundId: string,
): Promise<void> {
  const tx = h.tx as unknown as {
    restaurantOrderItem: { findMany: (a: unknown) => Promise<RoundItem[]> };
    productStationLink: {
      findMany: (a: unknown) => Promise<{ productId: string; stationId: string }[]>;
    };
    kitchenStation: { findMany: (a: unknown) => Promise<{ id: string }[]> };
    $queryRaw: (a?: unknown) => Promise<{ value: number }[]>;
    kitchenTicket: { create: (a: unknown) => Promise<CreatedTicket> };
    kitchenTicketItem: { create: (a: unknown) => Promise<unknown> };
  };

  const items = await tx.restaurantOrderItem.findMany({ where: { tenantId, roundId } });
  const links = await tx.productStationLink.findMany({ where: {} });
  const byProduct = new Map<string, string[]>();
  for (const link of links) {
    byProduct.set(link.productId, [...(byProduct.get(link.productId) ?? []), link.stationId]);
  }
  const stations = await tx.kitchenStation.findMany({
    where: { tenantId, branchId, isActive: true },
  });
  const soleStationId = stations.length === 1 ? stations[0]!.id : null;

  const perStation = new Map<string, RoundItem[]>();
  for (const it of items) {
    const stationIds = it.productId ? byProduct.get(it.productId) ?? [] : [];
    const targets = stationIds.length > 0 ? stationIds : soleStationId ? [soleStationId] : [];
    for (const stationId of targets) {
      perStation.set(stationId, [...(perStation.get(stationId) ?? []), it]);
    }
    // No target: silently dropped — the defect, faithfully reproduced.
  }

  for (const [stationId, stationItems] of perStation) {
    const rows = await tx.$queryRaw();
    const ticket = await tx.kitchenTicket.create({
      data: { tenantId, branchId, roundId, stationId, ticketNumber: `KOT-${rows[0]!.value}` },
    });
    for (const it of stationItems) {
      await tx.kitchenTicketItem.create({
        data: {
          tenantId,
          ticketId: ticket.id,
          menuItemName: it.menuItemName,
          variantName: it.variantNameSnapshot,
          quantity: it.quantity,
          modifierNames: it.modifiers.map((m) => m.optionName),
          specialInstructions: it.specialInstructions,
        },
      });
    }
  }
}
