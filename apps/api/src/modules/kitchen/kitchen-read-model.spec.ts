import { Prisma } from '@hardware-pos/database';

import { KitchenService } from './kitchen.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { SettingsService } from '../settings/settings.service';

/**
 * D152 — the kitchen's READ model names stations again.
 *
 * This file asserted the opposite under D147, when a ticket belonged to no
 * station: `stationName` was off the ticket view and off the per-item order
 * view, and the tests here pinned those absences. The split is back (D152), so
 * every one of those assertions is now false by DECISION and is rewritten to
 * the new truth rather than deleted (D16).
 *
 * What survives the reversal unchanged is the null tolerance. `stationId` is
 * still a nullable column with no backfill, so a ticket cut during the D147
 * window carries no station and joins none — and the projection must produce
 * `null` for it rather than throwing on `row.station.name`. That is a real
 * production row, so it has its own fixture here.
 *
 * Every claim is made in both directions (D30). "It names a station" asserted
 * alone would hold for a view that named the wrong one, or that had lost
 * everything else on the card; each station assertion is paired with the
 * fields that must still be there and with the row that must still map to null.
 *
 * Prisma is a stub; these are assertions about the shape the service
 * projects, not about the database.
 */

const TENANT = 'tnt_1';
const BRANCH = 'brn_1';
const TICKET = 'tkt_1';

/**
 * A ticket row exactly as `TICKET_INCLUDE` returns one under D152: items, the
 * station, the completing user, the round and its order.
 */
function ticketRow(
  station: { name: string } | null = { name: 'Grill' },
  stationId: string | null = 'stn_grill',
) {
  return {
    id: TICKET,
    ticketNumber: 'KOT-000027',
    branchId: BRANCH,
    roundId: 'rnd_1',
    stationId,
    station,
    status: 'QUEUED',
    completedAt: null,
    completedBy: null,
    createdAt: new Date('2026-09-09T04:30:00Z'),
    items: [
      {
        id: 'kti_1',
        menuItemName: 'Chicken Wings',
        variantName: null,
        quantity: new Prisma.Decimal(2),
        modifierNames: ['Extra spicy'],
        specialInstructions: null,
      },
      {
        id: 'kti_2',
        menuItemName: 'Watalappan',
        variantName: null,
        quantity: new Prisma.Decimal(1),
        modifierNames: [],
        specialInstructions: null,
      },
    ],
    round: {
      roundNumber: 1,
      order: {
        orderNumber: 'RO-000026',
        session: {
          waiterUserId: 'usr_1',
          tabName: null,
          table: { code: 'T4', area: { name: 'Terrace' } },
        },
      },
    },
  };
}

function makeService(rows = [ticketRow()]) {
  const kitchenTicket = {
    findMany: jest.fn().mockResolvedValue(rows),
    findFirst: jest
      .fn()
      .mockResolvedValue({ id: TICKET, ticketNumber: 'KOT-000027', roundId: 'rnd_1' }),
    /*
     * D154 — the list read now issues the three lane counts alongside it, and
     * they are stubbed DISTINCT on purpose: three equal numbers would let a
     * mapping that put `preparing` where `toMake` belongs pass (D30 §"two
     * counts happen to be equal"). What each count MEANS is pinned in
     * `kitchen-lane-counts.spec.ts`; here they only have to be told apart.
     */
    count: jest
      .fn()
      .mockResolvedValueOnce(4)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(9)
      .mockResolvedValue(rows.length),
  };
  const prisma = {
    kitchenTicket,
    user: {
      findMany: jest.fn().mockResolvedValue([{ id: 'usr_1', name: 'Nimal' }]),
      findUnique: jest.fn().mockResolvedValue({ name: 'Nimal' }),
    },
    orderRound: { findFirst: jest.fn().mockResolvedValue({ orderId: 'ord_1' }) },
    restaurantOrder: {
      findFirstOrThrow: jest.fn().mockResolvedValue({
        orderNumber: 'RO-000026',
        createdAt: new Date('2026-09-09T04:00:00Z'),
        session: {
          waiterUserId: 'usr_1',
          tabName: null,
          table: { code: 'T4', area: { name: 'Terrace' } },
        },
        items: [
          {
            id: 'itm_1',
            menuItemName: 'Chicken Wings',
            variantNameSnapshot: null,
            quantity: new Prisma.Decimal(2),
            specialInstructions: null,
            modifiers: [{ optionName: 'Extra spicy' }],
            round: { roundNumber: 1 },
          },
          {
            id: 'itm_2',
            menuItemName: 'Watalappan',
            variantNameSnapshot: null,
            quantity: new Prisma.Decimal(1),
            specialInstructions: null,
            modifiers: [],
            // D83's whole point: an item from an EARLIER round, which the
            // ticket itself does not carry.
            round: { roundNumber: 2 },
          },
        ],
      }),
    },
    $transaction: (ops: unknown[]) => Promise.all(ops),
  } as unknown as PrismaService;
  const settings = {
    getSettings: () => ({ timezone: 'Asia/Colombo' }),
  } as unknown as SettingsService;
  return { service: new KitchenService(prisma, settings), kitchenTicket };
}

describe('the ticket view (D152)', () => {
  it('projects the whole card AND names the station that cooks it', async () => {
    const { service } = makeService();

    /*
     * D154 — this read `const [view] = await …` until the list grew its
     * envelope, and the destructure is now false rather than merely unfashion-
     * able: the call returns `{ items, counts }`, so the old spelling would
     * hand `view` undefined. Rewritten to the new truth (D16), and the
     * envelope is asserted here rather than assumed — a projection test that
     * silently read `res.items` of `undefined` would fail with a TypeError
     * that says nothing about what broke.
     */
    const res = await service.listTicketsForBranch(TENANT, BRANCH, 'OUTSTANDING');

    expect(Array.isArray(res)).toBe(false);
    expect(res.counts).toEqual({ toMake: 4, preparing: 2, doneToday: 9 });
    const [view] = res.items;

    // POSITIVE — everything D68 put on the card is still on it. Without this
    // half, "it has a stationName" would also be true of a view that had lost
    // the order, the place and the waiter.
    expect(view!.ticketNumber).toBe('KOT-000027');
    expect(view!.orderNumber).toBe('RO-000026');
    expect(view!.placeLabel).toBe('T4 · Terrace');
    expect(view!.roundNumber).toBe(1);
    expect(view!.waiterName).toBe('Nimal');
    expect(view!.items.map((i) => i.menuItemName)).toEqual(['Chicken Wings', 'Watalappan']);
    // D152 — the ribbon's two halves, both from the row rather than inferred.
    expect(view!.stationId).toBe('stn_grill');
    expect(view!.stationName).toBe('Grill');
  });

  it('a ticket cut during the D147 window still projects, with both station fields null', async () => {
    /*
     * The column stays nullable and nothing was backfilled, so this row is
     * real. The claim is that the projection reads the relation through `?.`:
     * `row.station.name` against an unjoined station is a TypeError at request
     * time, on the board, in service.
     */
    const { service } = makeService([ticketRow(null, null)]);

    // D154 — through the envelope, like every other reader of this list.
    const [view] = (await service.listTicketsForBranch(TENANT, BRANCH, 'OUTSTANDING')).items;

    expect(view!.stationId).toBeNull();
    expect(view!.stationName).toBeNull();
    // POSITIVE — and the rest of the card survived, so "null" is the station
    // being absent and not the mapping having given up.
    expect(view!.ticketNumber).toBe('KOT-000027');
    expect(view!.items).toHaveLength(2);
  });

  it('the query joins the station relation again, and still joins the rest', async () => {
    const { service, kitchenTicket } = makeService();

    await service.listTicketsForBranch(TENANT, BRANCH, 'OUTSTANDING');

    const include = (kitchenTicket.findMany.mock.calls.at(-1)![0] as { include: object }).include;
    // POSITIVE — `station` is back, selecting the name the card prints…
    expect(include).toHaveProperty('station');
    expect((include as { station: unknown }).station).toEqual({ select: { name: true } });
    // …and the include is unchanged in every other respect, so this cannot
    // pass by the include having been rewritten to something else entirely.
    expect(include).toHaveProperty('items');
    expect(include).toHaveProperty('completedBy');
    expect(include).toHaveProperty('round');
  });
});

describe('the order behind a ticket (D83, restored by D152)', () => {
  it('returns every round’s items, labelled by round AND by the station that got them', async () => {
    const { service, kitchenTicket } = makeService();
    // The order's tickets, as the sweep reads them back: two stations, one
    // item each, which is exactly what the dialog is for.
    kitchenTicket.findMany.mockResolvedValue([
      { station: { name: 'Grill' }, items: [{ menuItemName: 'Chicken Wings' }] },
      { station: { name: 'Pastry' }, items: [{ menuItemName: 'Watalappan' }] },
    ]);

    const order = await service.orderForTicket(TENANT, BRANCH, TICKET);

    // POSITIVE — D83 still earns its place: the dialog shows the order's OTHER
    // rounds, which one ticket has never carried…
    expect(order.ticketNumber).toBe('KOT-000027');
    expect(order.items.map((i) => i.name)).toEqual(['Chicken Wings', 'Watalappan']);
    expect(order.items.map((i) => i.roundNumber)).toEqual([1, 2]);
    expect(order.items[0]!.modifierNames).toEqual(['Extra spicy']);
    // …and D152 gives each line the station that received it, which is what
    // makes the OTHER stations' work on this round legible from one card.
    expect(order.items.map((i) => i.stationName)).toEqual(['Grill', 'Pastry']);
  });

  it('an item whose ticket has no station keeps a null annotation, and borrows nobody else’s', async () => {
    const { service, kitchenTicket } = makeService();
    kitchenTicket.findMany.mockResolvedValue([
      { station: { name: 'Grill' }, items: [{ menuItemName: 'Chicken Wings' }] },
      // A D147-window ticket: it annotates nothing.
      { station: null, items: [{ menuItemName: 'Watalappan' }] },
    ]);

    const order = await service.orderForTicket(TENANT, BRANCH, TICKET);

    // NEGATIVE — the stationless ticket's item is null, NOT 'Grill'. A sweep
    // that skipped the null check would either throw or hand it a name no row
    // supports.
    expect(order.items.map((i) => i.stationName)).toEqual(['Grill', null]);
  });

  it('reads the stations back from the TICKETS, not from the routing links', async () => {
    const { service, kitchenTicket } = makeService();

    await service.orderForTicket(TENANT, BRANCH, TICKET);

    // POSITIVE — the ticket itself IS looked up (tenant/branch scoping, D70).
    expect(kitchenTicket.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: TICKET, tenantId: TENANT, branchId: BRANCH } }),
    );
    /*
     * D152 — and the order-wide sweep is back, scoped to the ORDER rather than
     * the round: the links can be edited after the fact, and the ticket is
     * what the kitchen actually received.
     */
    const args = kitchenTicket.findMany.mock.calls.at(-1)![0] as {
      where: unknown;
      select: unknown;
    };
    expect(args.where).toEqual({ tenantId: TENANT, round: { orderId: 'ord_1' } });
    expect(args.select).toEqual({
      station: { select: { name: true } },
      items: { select: { menuItemName: true } },
    });
  });
});
