import { Prisma } from '@hardware-pos/database';

import { KitchenService } from './kitchen.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { SettingsService } from '../settings/settings.service';

/**
 * D143 — the kitchen's READ model stopped naming stations.
 *
 * A ticket cut since the per-station split was removed belongs to no station,
 * so `stationName` came off the ticket view (the board card and the history
 * table) and off the per-item order view (the ticket-order dialog). The
 * projection must not go on reading a relation the query no longer joins:
 * `row.station.name` against an unjoined `station` is a TypeError at
 * request time, on the board, in service.
 *
 * Every claim here is made in both directions (D30). "No station" asserted
 * alone would hold just as well for a projection that returned nothing at
 * all, so each absence is paired with the fields that must still be there —
 * and the fixtures carry NO `station` key, which is what production now
 * returns, so a restored `row.station.name` fails rather than reading a
 * convenient stub.
 *
 * Prisma is a stub; these are assertions about the shape the service
 * projects, not about the database.
 */

const TENANT = 'tnt_1';
const BRANCH = 'brn_1';
const TICKET = 'tkt_1';

/**
 * A ticket row exactly as `TICKET_INCLUDE` now returns one: items, the
 * completing user, the round and its order — and no `station`.
 */
function ticketRow() {
  return {
    id: TICKET,
    ticketNumber: 'KOT-000027',
    branchId: BRANCH,
    roundId: 'rnd_1',
    // D143 — null on every ticket written since the split was removed.
    stationId: null,
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

function makeService() {
  const kitchenTicket = {
    findMany: jest.fn().mockResolvedValue([ticketRow()]),
    findFirst: jest
      .fn()
      .mockResolvedValue({ id: TICKET, ticketNumber: 'KOT-000027', roundId: 'rnd_1' }),
    count: jest.fn().mockResolvedValue(1),
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

describe('the ticket view (D143)', () => {
  it('projects the whole card and names no station', async () => {
    const { service } = makeService();

    const [view] = await service.listTicketsForBranch(TENANT, BRANCH, 'OUTSTANDING');

    // POSITIVE — everything D68 put on the card is still on it. Without this
    // half, "no stationName" would also be true of a view that broke entirely.
    expect(view!.ticketNumber).toBe('KOT-000027');
    expect(view!.orderNumber).toBe('RO-000026');
    expect(view!.placeLabel).toBe('T4 · Terrace');
    expect(view!.roundNumber).toBe(1);
    expect(view!.waiterName).toBe('Nimal');
    expect(view!.items.map((i) => i.menuItemName)).toEqual(['Chicken Wings', 'Watalappan']);
    // NEGATIVE — and it carries no station name at all.
    expect(view).not.toHaveProperty('stationName');
    expect(Object.keys(view!)).not.toContain('stationName');
    // `stationId` survives, nullable: a pre-D143 ticket keeps the station it
    // was genuinely routed to, and a new one says so by being null.
    expect(view!.stationId).toBeNull();
  });

  it('NEGATIVE — the query no longer joins the station relation, and still joins the rest', async () => {
    const { service, kitchenTicket } = makeService();

    await service.listTicketsForBranch(TENANT, BRANCH, 'OUTSTANDING');

    const include = (kitchenTicket.findMany.mock.calls.at(-1)![0] as { include: object }).include;
    // POSITIVE — the include is real and unchanged in every other respect.
    expect(include).toHaveProperty('items');
    expect(include).toHaveProperty('completedBy');
    expect(include).toHaveProperty('round');
    // NEGATIVE — no `station`. The fixture omits it too, so a projection that
    // read `row.station.name` would throw rather than quietly succeed.
    expect(include).not.toHaveProperty('station');
  });
});

describe('the order behind a ticket (D83, narrowed by D143)', () => {
  it('returns every round’s items, labelled by round and by no station', async () => {
    const { service } = makeService();

    const order = await service.orderForTicket(TENANT, BRANCH, TICKET);

    // POSITIVE — D83 still earns its place: the dialog shows the order's OTHER
    // rounds, which one ticket has never carried.
    expect(order.ticketNumber).toBe('KOT-000027');
    expect(order.items.map((i) => i.name)).toEqual(['Chicken Wings', 'Watalappan']);
    expect(order.items.map((i) => i.roundNumber)).toEqual([1, 2]);
    expect(order.items[0]!.modifierNames).toEqual(['Extra spicy']);
    // NEGATIVE — no per-item station annotation on any of them.
    for (const line of order.items) {
      expect(line).not.toHaveProperty('stationName');
    }
  });

  it('NEGATIVE — it no longer reads the tickets back to work out a station', async () => {
    const { service, kitchenTicket } = makeService();

    await service.orderForTicket(TENANT, BRANCH, TICKET);

    // POSITIVE — the ticket itself IS looked up (tenant/branch scoping, D70),
    // so "no calls" is not why the negative below holds.
    expect(kitchenTicket.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: TICKET, tenantId: TENANT, branchId: BRANCH } }),
    );
    // NEGATIVE — the order-wide ticket sweep that built `stationByName` is gone.
    expect(kitchenTicket.findMany).not.toHaveBeenCalled();
  });
});
