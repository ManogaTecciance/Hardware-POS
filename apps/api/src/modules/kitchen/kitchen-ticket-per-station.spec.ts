import { Prisma } from '@hardware-pos/database';

import { KitchenService, MAIN_STATION_CODE } from './kitchen.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { SettingsService } from '../settings/settings.service';

/**
 * D152 — a round is ONE TICKET PER STATION again, and NOTHING IS DROPPED.
 *
 * This file was `kitchen-ticket-per-round.spec.ts` and asserted the exact
 * opposite: D147 had collapsed a round to a single stationless ticket. It is
 * rewritten rather than deleted (D16) because its most valuable test survives
 * INVERTED — a round whose items span two stations must now yield TWO tickets
 * carrying the right items each, where it used to prove one carrying all.
 *
 * Two claims, and the second is the one with money attached:
 *
 * - A round produces one ticket per station its items route to, each holding
 *   only that station's lines and each with its own KOT number.
 * - An item with NO station link reaches the branch's MAIN station. It is not
 *   dropped, and it is not guessed at. The pre-D147 routing sent unlinked
 *   items to the sole active station when the branch had exactly one and
 *   DISCARDED them otherwise (D67); the affected branch has four, so an
 *   unlinked dish reached the board on NO ticket at all — ordered, billed,
 *   never cooked. That is what D152's Main fallback exists to end, and the
 *   mutation proof at the bottom shows this file rejects the drop's return.
 *
 * The fixture is deliberately hostile to both claims. Its branch has FOUR
 * ordinary stations plus Main, so "the unlinked item was routed" can never be
 * an artefact of D67's single-station fallback; its round spans three of them
 * plus one unlinked line plus one legacy MENU_ITEM line; and both link stubs
 * FILTER on the ids they are asked for, so a routing lookup that widened its
 * `where` would pull in the decoy link the D60 test relies on and fail.
 *
 * Prisma is a stub: the assertions are about the WRITES the service issues.
 * What the database does with them is pinned by the integration suite.
 */

const TENANT = 'tnt_1';
const BRANCH = 'brn_1';
const ROUND = 'rnd_1';

/*
 * The four ordinary stations the affected branch really has. Their only role
 * here is to be MORE THAN ONE: with a single active station D67's fallback
 * would have caught the unlinked item and the defect would not reproduce.
 *
 * `stn_hotline` is code KIT, name "Main Kitchen" — the seed's hot line, which
 * is NOT the MAIN fallback and must never be mistaken for it. Keeping both in
 * the fixture is what makes a mutant that falls back to "the first KITCHEN
 * station" fail rather than pass by coincidence.
 */
const STATIONS = {
  grill: 'stn_grill',
  hotline: 'stn_hotline',
  bar: 'stn_bar',
  pastry: 'stn_pastry',
} as const;

/** What `resolveMainStation`'s upsert hands back — a fifth, separate station. */
const MAIN_STATION_ID = 'stn_main_fallback';

/**
 * Product links. 'prd_pudding' has NONE — that is the whole point of it.
 */
const PRODUCT_LINKS = [
  { productId: 'prd_wings', stationId: STATIONS.grill },
  { productId: 'prd_seer', stationId: STATIONS.grill },
  { productId: 'prd_rice', stationId: STATIONS.hotline },
];

/**
 * Menu-item links, for D60. `mi_itm_5` is the legacy MENU_ITEM line's only
 * routing; `mi_itm_1` is a DECOY — its round item carries a `productId`, so
 * the product junction must win and this row must never be consulted. The
 * stub honours the `where`, so a lookup that stopped filtering would send
 * Chicken Wings to Pastry and the exact-set assertion would say so.
 */
const MENU_ITEM_LINKS = [
  { menuItemId: 'mi_itm_5', stationId: STATIONS.bar },
  { menuItemId: 'mi_itm_1', stationId: STATIONS.pastry },
];

type RoundItem = {
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
  productId: string | null,
  menuItemName: string,
  extra: Partial<RoundItem> = {},
): RoundItem {
  return {
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
 * grill, one for the hot line, one linked to nothing at all, and one legacy
 * MENU_ITEM line that routes through the other junction.
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
  item('itm_5', null, 'Plain Tea'),
];

const ALL_NAMES = [
  'Chicken Wings',
  'Fried Rice',
  'Grilled Seer Fish',
  'Watalappan',
  'Plain Tea',
];
/** The item the old routing dropped: no station link, multi-station branch. */
const UNLINKED_NAME = 'Watalappan';

/** Where each station's ticket must end up, for the whole fixture round. */
const EXPECTED_SPLIT: Record<string, string[]> = {
  [STATIONS.grill]: ['Chicken Wings', 'Grilled Seer Fish'],
  [STATIONS.hotline]: ['Fried Rice'],
  [MAIN_STATION_ID]: [UNLINKED_NAME],
  [STATIONS.bar]: ['Plain Tea'],
};

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
    kitchenStation: { upsert: jest.Mock; findMany: jest.Mock };
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
     * Both junctions HONOUR the `where` they are handed. A stub that returned
     * its whole table regardless would make the D60 test below vacuous: the
     * decoy link would come back whether the service scoped the query or not
     * (D30).
     */
    menuItemStationLink: {
      findMany: jest.fn().mockImplementation((args: { where: { menuItemId: { in: string[] } } }) =>
        Promise.resolve(
          MENU_ITEM_LINKS.filter((l) => args.where.menuItemId.in.includes(l.menuItemId)),
        ),
      ),
    },
    productStationLink: {
      findMany: jest.fn().mockImplementation((args: { where: { productId: { in: string[] } } }) =>
        Promise.resolve(
          PRODUCT_LINKS.filter((l) => args.where.productId.in.includes(l.productId)),
        ),
      ),
    },
    kitchenStation: {
      // D152 — Main is UPSERTED, so it exists whether or not the seed ran.
      upsert: jest.fn().mockResolvedValue({ id: MAIN_STATION_ID }),
      // Present and unused: the D67 catalogue sweep must be gone, and a stub
      // that did not exist would make "never called" true for the wrong reason.
      findMany: jest.fn().mockResolvedValue([]),
    },
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

/** What was written against each ticket, keyed by the station it belongs to. */
function namesByStation(created: CreatedTicket[], written: WrittenItem[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const ticket of created) {
    // A null station would collide every stationless ticket into one key and
    // hide the split — refused loudly rather than bucketed.
    if (ticket.stationId === null) throw new Error(`ticket ${ticket.id} carries no station`);
    out[ticket.stationId] = written
      .filter((w) => w.ticketId === ticket.id)
      .map((w) => w.menuItemName);
  }
  return out;
}

/**
 * D152's contract, in one place, so the mutation proofs at the bottom are run
 * against exactly the check every test above rests on. If this ever stops
 * distinguishing the split from the drop, the proofs fail and say so.
 */
function assertSplitAndNothingDropped(
  created: CreatedTicket[],
  written: WrittenItem[],
  expected: Record<string, string[]>,
  everyRoundItem: string[],
): void {
  // One ticket per expected station, no more and no fewer, each carrying
  // exactly its own lines. Sets, not counts (D30 §3).
  expect(namesByStation(created, written)).toEqual(expected);
  expect(created.map((t) => t.stationId).sort()).toEqual(Object.keys(expected).sort());
  // THE HARD RULE, asserted independently of the map above: every item of the
  // round reached a ticket. Not "the counts matched" — the names.
  const reached = new Set(written.map((w) => w.menuItemName));
  expect([...everyRoundItem].sort().filter((n) => reached.has(n))).toEqual(
    [...everyRoundItem].sort(),
  );
  // …and nothing was written that the round never contained.
  expect([...reached].sort()).toEqual([...new Set(everyRoundItem)].sort());
}

describe('KitchenService.generateTicketsForRound — the split (D152)', () => {
  it('a round whose items span two stations yields TWO tickets, carrying the right items each', async () => {
    /*
     * The inverted survivor of the D147 spec. Only the two grill dishes and
     * the hot line's rice, so the claim cannot lean on Main or on the legacy
     * junction: two stations in, two tickets out, and the items on the ticket
     * of the station that cooks them.
     */
    const h = makeHarness([ROUND_ITEMS[0]!, ROUND_ITEMS[1]!, ROUND_ITEMS[2]!]);

    const ticketIds = await h.service.generateTicketsForRound(h.tx, TENANT, BRANCH, ROUND);

    expect(h.created).toHaveLength(2);
    assertSplitAndNothingDropped(
      h.created,
      h.written,
      {
        [STATIONS.grill]: ['Chicken Wings', 'Grilled Seer Fish'],
        [STATIONS.hotline]: ['Fried Rice'],
      },
      ['Chicken Wings', 'Fried Rice', 'Grilled Seer Fish'],
    );
    expect(ticketIds).toEqual(h.created.map((t) => t.id));
    // One KOT number PER TICKET — two cards on the pass that shared a number
    // could not be told apart by the people calling them out.
    expect(h.raw.$queryRaw).toHaveBeenCalledTimes(2);
    expect(h.created.map((t) => t.ticketNumber)).toEqual(['KOT-000027', 'KOT-000028']);
  });

  it('the whole round splits four ways, and the UNLINKED item is on the Main ticket', async () => {
    const h = makeHarness();

    const ticketIds = await h.service.generateTicketsForRound(h.tx, TENANT, BRANCH, ROUND);

    assertSplitAndNothingDropped(h.created, h.written, EXPECTED_SPLIT, ALL_NAMES);
    expect(ticketIds).toHaveLength(4);
    // Stated on its own because it is the rule with money attached: the dish
    // nothing links reached a ticket, and it reached MAIN's — not the grill's,
    // not the hot line's, and not nobody's.
    const main = h.created.find((t) => t.stationId === MAIN_STATION_ID)!;
    expect(main).toBeDefined();
    expect(h.written.filter((w) => w.ticketId === main.id).map((w) => w.menuItemName)).toEqual([
      UNLINKED_NAME,
    ]);
    // And the branch really did have more than one station to choose between —
    // with one, D67's fallback would have routed it and there'd be no defect.
    expect(Object.keys(STATIONS).length).toBeGreaterThan(1);
  });

  it('NOTHING IS DROPPED — every line of the round reaches a ticket, unlinked included', async () => {
    const h = makeHarness();

    await h.service.generateTicketsForRound(h.tx, TENANT, BRANCH, ROUND);

    const reached = h.written.map((w) => w.menuItemName).sort();
    // POSITIVE — the exact set the round carried, so this cannot pass by the
    // service having written some unrelated pile of rows…
    expect(reached).toEqual([...ALL_NAMES].sort());
    // …NEGATIVE — and in particular the one D67 discarded is not missing.
    expect(reached).toContain(UNLINKED_NAME);
  });

  it('D67 is gone: no sole-station sweep, and Main is upserted rather than assumed', async () => {
    const h = makeHarness();

    await h.service.generateTicketsForRound(h.tx, TENANT, BRANCH, ROUND);

    // POSITIVE — Main is resolved by an upsert keyed on the branch's unique
    // (branchId, code), created with the shape D152 names, and made active:
    // an archived Main vanishes from the board's station filter while still
    // receiving tickets.
    expect(h.raw.kitchenStation.upsert).toHaveBeenCalledTimes(1);
    const args = h.raw.kitchenStation.upsert.mock.calls[0]![0] as {
      where: unknown;
      update: unknown;
      create: Record<string, unknown>;
    };
    // The literal, not only the constant: `MAIN_STATION_CODE` on both sides
    // would agree with itself whatever the constant became, and the seed and
    // every branch already in the database spell it 'MAIN'.
    expect(MAIN_STATION_CODE).toBe('MAIN');
    expect(args.where).toEqual({ branchId_code: { branchId: BRANCH, code: 'MAIN' } });
    expect(args.update).toEqual({ isActive: true });
    expect(args.create).toEqual({
      tenantId: TENANT,
      branchId: BRANCH,
      code: 'MAIN',
      name: 'Main',
      category: 'KITCHEN',
    });
    // NEGATIVE — and the catalogue sweep that computed `soleStationId` is not
    // there to fall back to. The stub exists and answers, so "never called" is
    // a fact about the service and not about a missing mock.
    expect(h.raw.kitchenStation.findMany).not.toHaveBeenCalled();
  });

  it('resolves Main ONCE per round, even when nothing is unlinked', async () => {
    // "Once per round" is a claim about cost and about consistency; and it is
    // resolved unconditionally, because Main must exist wherever a round is
    // submitted, not only where this particular round happened to need it.
    const h = makeHarness([ROUND_ITEMS[0]!, ROUND_ITEMS[2]!]);

    await h.service.generateTicketsForRound(h.tx, TENANT, BRANCH, ROUND);

    expect(h.raw.kitchenStation.upsert).toHaveBeenCalledTimes(1);
    // POSITIVE — and this round genuinely needed no fallback: one ticket, the
    // grill's, so the upsert above is not being counted on a round that used it.
    expect(namesByStation(h.created, h.written)).toEqual({
      [STATIONS.grill]: ['Chicken Wings', 'Grilled Seer Fish'],
    });
  });

  it('two unlinked items share ONE Main ticket rather than one each', async () => {
    const h = makeHarness([
      ROUND_ITEMS[3]!,
      item('itm_6', 'prd_jelly', 'Wattalappan Jelly'),
      ROUND_ITEMS[0]!,
    ]);

    await h.service.generateTicketsForRound(h.tx, TENANT, BRANCH, ROUND);

    assertSplitAndNothingDropped(
      h.created,
      h.written,
      {
        [MAIN_STATION_ID]: ['Watalappan', 'Wattalappan Jelly'],
        [STATIONS.grill]: ['Chicken Wings'],
      },
      ['Watalappan', 'Wattalappan Jelly', 'Chicken Wings'],
    );
    expect(h.raw.kitchenStation.upsert).toHaveBeenCalledTimes(1);
  });

  it('D60 — the PRODUCT junction wins whenever the line carries a productId', async () => {
    const h = makeHarness();

    await h.service.generateTicketsForRound(h.tx, TENANT, BRANCH, ROUND);

    // POSITIVE — the legacy MENU_ITEM line (no productId) routed through the
    // menu-item junction and reached the Bar, so that junction IS consulted.
    expect(namesByStation(h.created, h.written)[STATIONS.bar]).toEqual(['Plain Tea']);
    const miArgs = h.raw.menuItemStationLink.findMany.mock.calls[0]![0] as {
      where: { menuItemId: { in: string[] } };
    };
    expect(miArgs.where.menuItemId.in).toEqual(['mi_itm_5']);
    // NEGATIVE — and the product-carrying line's own menu item is NOT in that
    // query, so its decoy Pastry link cannot reach the routing. Pastry gets no
    // ticket at all, and Chicken Wings is on the Grill's.
    expect(miArgs.where.menuItemId.in).not.toContain('mi_itm_1');
    expect(h.created.map((t) => t.stationId)).not.toContain(STATIONS.pastry);
    const prArgs = h.raw.productStationLink.findMany.mock.calls[0]![0] as {
      where: { productId: { in: string[] } };
    };
    expect(prArgs.where.productId.in.sort()).toEqual(
      ['prd_pudding', 'prd_rice', 'prd_seer', 'prd_wings'].sort(),
    );
  });

  it('asks only for stations THIS branch can cook at, so a stale link cannot hide a dish', async () => {
    /*
     * Both junctions are tenant-wide and neither is rewritten when a station
     * is archived or when a product is used at another branch. So a link can
     * name a station that this branch's board cannot select:
     *
     *   - an ARCHIVED station — the chip strip lists active stations only;
     *   - a station belonging to ANOTHER BRANCH — not on this board at all.
     *
     * Either one, left unfiltered, makes the item's station list non-empty,
     * so Main never fires and the ticket is written somewhere no cook is
     * looking. Ordered, billed, never seen — the D147 failure through a
     * different door.
     *
     * Asserted on the QUERY, because that is where the guarantee lives: a
     * link that cannot survive this `where` leaves the item unrouted, and the
     * unrouted path is already proven to end at Main.
     */
    const h = makeHarness();

    await h.service.generateTicketsForRound(h.tx, TENANT, BRANCH, ROUND);

    for (const call of [
      h.raw.menuItemStationLink.findMany.mock.calls[0]![0],
      h.raw.productStationLink.findMany.mock.calls[0]![0],
    ] as { where: { station?: { branchId?: string; isActive?: boolean } } }[]) {
      // POSITIVE — both legs constrain the station, both ways.
      expect(call.where.station).toEqual({ branchId: BRANCH, isActive: true });
    }
  });

  it('routes an item whose ONLY link is unusable to Main, exactly like an unlinked one', async () => {
    /*
     * The behavioural half of the test above. The stub honours the `where` it
     * is given, so a link to an archived or other-branch station is filtered
     * out before routing sees it — and the item must then land on Main rather
     * than on nothing.
     *
     * Without the `station` filter this test goes red in the most dangerous
     * way possible: the dish gets a ticket, so a count-only assertion would
     * still pass, but that ticket belongs to a station no chip can select.
     */
    const h = makeHarness();
    // The only link this dish has points at a station that is not usable here.
    h.raw.productStationLink.findMany.mockImplementation(
      (args: { where: { station?: { branchId?: string; isActive?: boolean } } }) =>
        // Honour the filter: an unusable link is simply not returned.
        Promise.resolve(args.where.station ? [] : [{ productId: 'prd_wings', stationId: 'stn_elsewhere' }]),
    );

    await h.service.generateTicketsForRound(h.tx, TENANT, BRANCH, ROUND);

    const byStation = namesByStation(h.created, h.written);
    // POSITIVE — the dish is on Main's ticket…
    expect(byStation[MAIN_STATION_ID]).toContain('Chicken Wings');
    // NEGATIVE — …and nowhere near the station its stale link named.
    expect(h.created.map((t) => t.stationId)).not.toContain('stn_elsewhere');
    // And still nothing was dropped, which is the rule all of this serves.
    expect(Object.values(byStation).flat().sort()).toEqual([...ALL_NAMES].sort());
  });

  it('an item linked to TWO stations reaches both tickets — the link list is a list', async () => {
    /*
     * Restored behaviour, not new: a dish the operator linked to two lines is
     * cooked on both, and the pre-D147 grouping looped over every target for
     * exactly that reason. Pinned because a "first link wins" simplification
     * would look identical on every other fixture in this file.
     */
    const h = makeHarness([item('itm_7', 'prd_platter', 'Mixed Grill Platter')]);
    h.raw.productStationLink.findMany.mockResolvedValue([
      { productId: 'prd_platter', stationId: STATIONS.grill },
      { productId: 'prd_platter', stationId: STATIONS.hotline },
    ]);

    await h.service.generateTicketsForRound(h.tx, TENANT, BRANCH, ROUND);

    expect(namesByStation(h.created, h.written)).toEqual({
      [STATIONS.grill]: ['Mixed Grill Platter'],
      [STATIONS.hotline]: ['Mixed Grill Platter'],
    });
    // NEGATIVE — and it did NOT also land on Main: it was linked, twice.
    expect(h.created.map((t) => t.stationId)).not.toContain(MAIN_STATION_ID);
  });

  it('reads the routing inputs the split needs, and the round’s own order', async () => {
    const h = makeHarness();

    await h.service.generateTicketsForRound(h.tx, TENANT, BRANCH, ROUND);

    const args = h.raw.restaurantOrderItem.findMany.mock.calls[0]![0] as {
      where: Record<string, unknown>;
      select: Record<string, unknown>;
      orderBy: unknown;
    };
    expect(args.where).toEqual({ tenantId: TENANT, roundId: ROUND });
    // POSITIVE — the two routing keys are selected again (D60), alongside what
    // a ticket line needs and D46's variant.
    expect(Object.keys(args.select).sort()).toEqual([
      'menuItemId',
      'menuItemName',
      'modifiers',
      'productId',
      'quantity',
      'specialInstructions',
      'variantNameSnapshot',
    ]);
    /*
     * D147 added this ordering and D152 keeps it: `createdAt` alone would not
     * do, because a round's items are written inside one transaction and
     * Postgres stamps them all with the same instant, so two lines on one
     * station's ticket could swap places between two reads.
     */
    expect(args.orderBy).toEqual([{ createdAt: 'asc' }, { id: 'asc' }]);
    // The order that came back is the order each station's ticket was written in.
    expect(namesByStation(h.created, h.written)[STATIONS.grill]).toEqual([
      'Chicken Wings',
      'Grilled Seer Fish',
    ]);
  });

  it('carries the D46 variant snapshot, the modifier names and the instructions verbatim', async () => {
    const h = makeHarness();

    await h.service.generateTicketsForRound(h.tx, TENANT, BRANCH, ROUND);

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

  it('a round with no items writes nothing at all and returns no ids', async () => {
    const h = makeHarness([]);

    const ticketIds = await h.service.generateTicketsForRound(h.tx, TENANT, BRANCH, ROUND);

    expect(ticketIds).toEqual([]);
    expect(h.created).toEqual([]);
    expect(h.written).toEqual([]);
    // An empty round must not burn a KOT number — the sequence has no gaps to
    // spare and the pass has no card to show — nor touch the station
    // catalogue: there is nothing to route.
    expect(h.raw.$queryRaw).not.toHaveBeenCalled();
    expect(h.raw.kitchenStation.upsert).not.toHaveBeenCalled();
    expect(h.raw.productStationLink.findMany).not.toHaveBeenCalled();
  });

  it('MUTATION PROOF — restoring D67’s drop, or guessing a station, turns these assertions red', async () => {
    /*
     * Two mutants, both run against the SAME stub and read through the SAME
     * assertion the tests above rest on, so this proves the assertion
     * discriminates rather than merely passing.
     *
     *  1. THE DROP. The code that shipped before D147: fall back to the
     *     branch's sole active station (there isn't one — four stations plus
     *     Main) and silently discard whatever routes nowhere.
     *  2. THE GUESS. Route unlinked items to the first station the links
     *     mention instead of Main. Nothing is dropped, so a spec that only
     *     counted written rows would call this correct; it puts a dessert on
     *     the grill.
     */
    const shipped = makeHarness();
    await shipped.service.generateTicketsForRound(shipped.tx, TENANT, BRANCH, ROUND);
    // The shipped code satisfies the tripwire…
    assertSplitAndNothingDropped(shipped.created, shipped.written, EXPECTED_SPLIT, ALL_NAMES);

    const dropped = makeHarness();
    await routingMutant(dropped, 'drop');
    // …the drop mutant genuinely reproduces the old behaviour — the unlinked
    // dish on no ticket whatsoever…
    expect(dropped.written.map((w) => w.menuItemName)).not.toContain(UNLINKED_NAME);
    expect(dropped.created.map((t) => t.stationId)).not.toContain(MAIN_STATION_ID);
    // …and every leg of the tripwire rejects it.
    expect(() =>
      assertSplitAndNothingDropped(dropped.created, dropped.written, EXPECTED_SPLIT, ALL_NAMES),
    ).toThrow();
    expect(() =>
      expect(dropped.written.map((w) => w.menuItemName)).toContain(UNLINKED_NAME),
    ).toThrow();

    const guessed = makeHarness();
    await routingMutant(guessed, 'first-station');
    // The guess mutant drops nothing — the "nothing dropped" leg alone would
    // pass it…
    expect(guessed.written.map((w) => w.menuItemName).sort()).toEqual([...ALL_NAMES].sort());
    // …and the per-station map catches it anyway: Watalappan is on the grill.
    expect(namesByStation(guessed.created, guessed.written)[STATIONS.grill]).toContain(
      UNLINKED_NAME,
    );
    expect(() =>
      assertSplitAndNothingDropped(guessed.created, guessed.written, EXPECTED_SPLIT, ALL_NAMES),
    ).toThrow();
  });
});

/**
 * The two wrong routings, reimplemented here and NOWHERE ELSE, purely so the
 * mutation proof above has something real to reject. Both write through the
 * harness's own stub, so what they produce is read exactly as the shipped
 * service's output is.
 *
 * `drop` is the pre-D147 code: D67's sole-station fallback, and silence for
 * everything else. `first-station` keeps every item but sends the unlinked
 * ones to whichever station the links happened to mention first.
 */
async function routingMutant(h: Harness, mode: 'drop' | 'first-station'): Promise<void> {
  const tx = h.tx as unknown as {
    restaurantOrderItem: { findMany: (a: unknown) => Promise<RoundItem[]> };
    productStationLink: {
      findMany: (a: unknown) => Promise<{ productId: string; stationId: string }[]>;
    };
    menuItemStationLink: {
      findMany: (a: unknown) => Promise<{ menuItemId: string; stationId: string }[]>;
    };
    kitchenStation: { findMany: (a: unknown) => Promise<{ id: string }[]> };
    $queryRaw: (a?: unknown) => Promise<{ value: number }[]>;
    kitchenTicket: { create: (a: unknown) => Promise<CreatedTicket> };
    kitchenTicketItem: { create: (a: unknown) => Promise<unknown> };
  };

  const items = await tx.restaurantOrderItem.findMany({
    where: { tenantId: TENANT, roundId: ROUND },
  });
  const productLinks = await tx.productStationLink.findMany({
    where: { productId: { in: items.map((i) => i.productId).filter(Boolean) } },
  });
  const menuLinks = await tx.menuItemStationLink.findMany({
    where: {
      menuItemId: { in: items.filter((i) => i.productId === null).map((i) => i.menuItemId) },
    },
  });
  const byProduct = new Map<string, string[]>();
  for (const link of productLinks) {
    byProduct.set(link.productId, [...(byProduct.get(link.productId) ?? []), link.stationId]);
  }
  const byMenuItem = new Map<string, string[]>();
  for (const link of menuLinks) {
    byMenuItem.set(link.menuItemId, [...(byMenuItem.get(link.menuItemId) ?? []), link.stationId]);
  }

  // D67, faithfully: the branch has more than one active station, so there is
  // no sole station and unrouted items have nowhere to go.
  const stations = await tx.kitchenStation.findMany({
    where: { tenantId: TENANT, branchId: BRANCH, isActive: true },
  });
  const soleStationId = stations.length === 1 ? stations[0]!.id : null;

  const perStation = new Map<string, RoundItem[]>();
  const firstMentioned = productLinks[0]?.stationId ?? menuLinks[0]?.stationId ?? null;
  for (const it of items) {
    const stationIds = it.productId
      ? byProduct.get(it.productId) ?? []
      : byMenuItem.get(it.menuItemId) ?? [];
    const fallback = mode === 'drop' ? soleStationId : firstMentioned;
    const targets = stationIds.length > 0 ? stationIds : fallback ? [fallback] : [];
    for (const stationId of targets) {
      perStation.set(stationId, [...(perStation.get(stationId) ?? []), it]);
    }
    // No target: silently dropped — the defect, faithfully reproduced.
  }

  for (const [stationId, stationItems] of perStation) {
    const rows = await tx.$queryRaw();
    const ticket = await tx.kitchenTicket.create({
      data: { tenantId: TENANT, branchId: BRANCH, roundId: ROUND, stationId, ticketNumber: `KOT-${rows[0]!.value}` },
    });
    for (const it of stationItems) {
      await tx.kitchenTicketItem.create({
        data: {
          tenantId: TENANT,
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
