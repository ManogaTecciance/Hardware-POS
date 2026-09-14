import { RestaurantOrdersService, roundPreviews } from './restaurant-orders.service';

/**
 * D153a — each round's kitchen state on the queue row; D154 — the two status
 * buckets the tabs ask for.
 *
 * Paired per D30 throughout:
 *   - the preview GROUPS items onto the round that carries them and ORDERS
 *     rounds by number (positive), and a stub without round ids previews
 *     nothing rather than swallowing every item into a phantom round
 *     (negative);
 *   - `OUTSTANDING` returns exactly the unfinished rows and `DONE` exactly the
 *     finished ones, and — the guard every older spec depends on — no status
 *     at all still returns the whole set. A filter that dropped the finished
 *     rows from a bare list would pass the first two and fail the third.
 */

interface Row {
  id: string;
  orderNumber: string;
  createdAt: Date;
  channel: 'DINE_IN' | 'TAKEAWAY';
  status: string;
  session: { id: string; status: string; finalSaleId: string | null; table: null } | null;
  items: { menuItemName: string; quantity: number; roundId?: string | null }[];
  rounds: { id?: string; roundNumber?: number; status: string }[];
  takeawayProfile: {
    status: string;
    customerName: string | null;
    customerPhone: string | null;
    pickupAt: Date | null;
  } | null;
}

function order(id: string, over: Partial<Row> = {}): Row {
  return {
    id,
    orderNumber: id.toUpperCase(),
    createdAt: new Date('2026-09-11T12:00:00Z'),
    channel: 'DINE_IN',
    status: 'SUBMITTED',
    session: { id: 'ses_' + id, status: 'OPEN', finalSaleId: null, table: null },
    items: [],
    rounds: [],
    takeawayProfile: null,
    ...over,
  };
}

function takeaway(id: string, takeawayStatus: string): Row {
  return order(id, {
    channel: 'TAKEAWAY',
    takeawayProfile: { status: takeawayStatus, customerName: 'Nimal', customerPhone: null, pickupAt: null },
  });
}

function external(id: string, status = 'ACCEPTED') {
  return {
    id,
    externalOrderRef: id.toUpperCase(),
    status,
    receivedAt: new Date('2026-09-11T12:00:00Z'),
    externalTotal: 1850,
    platform: { kind: 'UBER_EATS' },
    items: [],
  };
}

function serviceWith(rows: Row[], externals: ReturnType<typeof external>[] = []) {
  const prisma = {
    restaurantOrder: { findMany: jest.fn(async () => rows) },
    sale: { findMany: jest.fn(async () => []) },
    externalOrder: { findMany: jest.fn(async () => externals) },
  } as never;
  return new RestaurantOrdersService(prisma);
}

const TENANT = 'tnt_1';
const BRANCH = 'brn_1';

const TWO_ROUNDS = order('ord_2r', {
  // Deliberately out of order, so the sort is exercised rather than trusted.
  rounds: [
    { id: 'rnd_2', roundNumber: 2, status: 'IN_PROGRESS' },
    { id: 'rnd_1', roundNumber: 1, status: 'READY' },
  ],
  items: [
    { menuItemName: 'Fried Rice', quantity: 1, roundId: 'rnd_1' },
    { menuItemName: 'Egg', quantity: 2, roundId: 'rnd_1' },
    { menuItemName: 'Milkshake', quantity: 1, roundId: 'rnd_2' },
  ],
});

describe('roundPreviews (D153a)', () => {
  it('groups each item onto its round and lists rounds by number', () => {
    expect(roundPreviews(TWO_ROUNDS.rounds, TWO_ROUNDS.items)).toEqual([
      {
        roundNumber: 1,
        status: 'READY',
        items: [
          { name: 'Fried Rice', qty: 1 },
          { name: 'Egg', qty: 2 },
        ],
      },
      { roundNumber: 2, status: 'IN_PROGRESS', items: [{ name: 'Milkshake', qty: 1 }] },
    ]);
  });

  it('previews nothing for a round the caller did not identify', () => {
    // The paging and scope specs stub rounds with a status alone. Those rows
    // must not grow a phantom "Round undefined" holding every item.
    expect(roundPreviews([{ status: 'READY' }], TWO_ROUNDS.items)).toEqual([]);
  });

  it('rides on the queue row, and a third-party row carries none', async () => {
    const res = await serviceWith([TWO_ROUNDS], [external('ext_1')]).listOrders(TENANT, BRANCH);
    const byNumber = Object.fromEntries(res.items.map((r) => [r.orderNumber, r.rounds]));
    expect(byNumber.ORD_2R.map((r) => [r.roundNumber, r.status])).toEqual([
      [1, 'READY'],
      [2, 'IN_PROGRESS'],
    ]);
    expect(byNumber.EXT_1).toEqual([]);
    // …and the order-level status still waits for every round.
    expect(res.items.find((r) => r.id === 'ord_2r')?.unifiedStatus).toBe('IN_PROGRESS');
  });
});

describe('the OUTSTANDING and DONE buckets (D154)', () => {
  const rows = [
    order('ord_pending'),
    order('ord_ready', { rounds: [{ id: 'r', roundNumber: 1, status: 'READY' }] }),
    order('ord_till', { session: { id: 's', status: 'BILLING', finalSaleId: 'sal', table: null } }),
    order('ord_paid', { status: 'COMPLETED' }),
    order('ord_off', { status: 'CANCELLED' }),
    takeaway('tk_bag', 'HANDED_OVER'),
  ];
  const numbers = async (query: Parameters<RestaurantOrdersService['listOrders']>[2]) =>
    (await serviceWith(rows, [external('ext_done', 'DELIVERED')]).listOrders(TENANT, BRANCH, query)).items
      .map((r) => r.orderNumber)
      .sort();

  it('OUTSTANDING is everything that is not finished', async () => {
    expect(await numbers({ status: 'OUTSTANDING' })).toEqual([
      'ORD_OFF',
      'ORD_PENDING',
      'ORD_READY',
      'ORD_TILL',
    ]);
  });

  it('DONE is exactly the finished rows — paid tables, handed-over bags, delivered platform orders', async () => {
    expect(await numbers({ status: 'DONE' })).toEqual(['EXT_DONE', 'ORD_PAID', 'TK_BAG']);
  });

  it('no status, and ALL, still return the whole set — the guard older specs rely on', async () => {
    const everything = ['EXT_DONE', 'ORD_OFF', 'ORD_PAID', 'ORD_PENDING', 'ORD_READY', 'ORD_TILL', 'TK_BAG'];
    expect(await numbers({})).toEqual(everything);
    expect(await numbers({ status: 'ALL' })).toEqual(everything);
  });

  it('a single status still means that status alone (an old bookmark keeps working)', async () => {
    expect(await numbers({ status: 'COMPLETED' })).toEqual(['ORD_PAID']);
    expect(await numbers({ status: 'HANDED_OVER' })).toEqual(['EXT_DONE', 'TK_BAG']);
    expect(await numbers({ status: 'AWAITING_PAYMENT' })).toEqual(['ORD_TILL']);
  });

  it('the tallies are unchanged by the bucket — the tabs still add up', async () => {
    const res = await serviceWith(rows).listOrders(TENANT, BRANCH, { status: 'OUTSTANDING' });
    expect(res.statusCounts.COMPLETED).toBe(1);
    expect(res.statusCounts.HANDED_OVER).toBe(1);
    expect(res.statusCounts.AWAITING_PAYMENT).toBe(1);
    expect(res.total).toBe(4);
  });
});
