import { RestaurantOrdersService } from './restaurant-orders.service';

/**
 * What the queue reports for money owed, and what the Unpaid filter finds.
 *
 * The defect these pin: `paymentStatus` was `sale?.paymentStatus ?? null`, and
 * a Sale only exists once an order is settled. So an order that was placed,
 * cooked and handed over but never billed reported NO payment status — and the
 * Unpaid filter, an equality test against that field, could never match it
 * (`null === 'UNPAID'` is false). The one filter a manager uses to chase money
 * returned only the orders that had already been billed, and hid every table
 * still holding it.
 *
 * Every case therefore asserts the state AND its absence elsewhere: a
 * projection that stamped UNPAID on everything would pass the unbilled cases
 * alone, and one that still returned null everywhere would pass the
 * cancelled/third-party cases alone. Neither passes both.
 */

interface Row {
  id: string;
  orderNumber: string;
  createdAt: Date;
  channel: 'DINE_IN' | 'TAKEAWAY';
  status: string;
  session: { finalSaleId: string | null; table: null } | null;
  items: { menuItemName: string; quantity: number }[];
  rounds: { status: string }[];
  takeawayProfile: null;
}

interface SaleRow {
  id: string;
  paymentStatus: 'UNPAID' | 'PARTIAL' | 'PAID' | 'REFUNDED';
  total: number;
}

function order(id: string, status: string, finalSaleId: string | null = null): Row {
  return {
    id,
    orderNumber: id.toUpperCase(),
    createdAt: new Date('2026-09-08T12:00:00Z'),
    channel: 'DINE_IN',
    status,
    session: { finalSaleId, table: null },
    items: [{ menuItemName: 'Rice and Curry', quantity: 1 }],
    rounds: [],
    takeawayProfile: null,
  };
}

/** An ExternalOrder row — payment for these is collected by the platform. */
function external(id: string) {
  return {
    id,
    externalOrderRef: id.toUpperCase(),
    status: 'ACCEPTED',
    receivedAt: new Date('2026-09-08T12:00:00Z'),
    externalTotal: 1850,
    platform: { kind: 'UBER_EATS' },
    items: [],
  };
}

function serviceWith(rows: Row[], sales: SaleRow[] = [], externals: ReturnType<typeof external>[] = []) {
  const prisma = {
    restaurantOrder: { findMany: jest.fn(async () => rows) },
    sale: { findMany: jest.fn(async () => sales) },
    externalOrder: { findMany: jest.fn(async () => externals) },
  } as never;
  return new RestaurantOrdersService(prisma);
}

const TENANT = 'tnt_1';
const BRANCH = 'brn_1';

/** paymentStatus keyed by order number, so a case reads as a table. */
async function paymentByOrder(
  service: RestaurantOrdersService,
  query: Parameters<RestaurantOrdersService['listOrders']>[2] = {},
) {
  const res = await service.listOrders(TENANT, BRANCH, query);
  return Object.fromEntries(res.items.map((r) => [r.orderNumber, r.paymentStatus]));
}

describe('payment status on an unbilled order', () => {
  it('reports UNPAID for a live order that has no Sale yet', async () => {
    // SUBMITTED with no rounds derives PENDING: placed, nothing cooked, and
    // certainly nothing paid.
    const service = serviceWith([order('ord_1', 'SUBMITTED'), order('ord_2', 'COMPLETED')]);

    expect(await paymentByOrder(service)).toEqual({ ORD_1: 'UNPAID', ORD_2: 'UNPAID' });
  });

  it('leaves a cancelled or draft order with no payment state at all', async () => {
    // Nothing was ever owed on these. Badging them Unpaid would park permanent
    // false debt in the queue, which is why they are NOT simply "no sale".
    const service = serviceWith([order('ord_1', 'CANCELLED'), order('ord_2', 'DRAFT')]);

    expect(await paymentByOrder(service)).toEqual({ ORD_1: null, ORD_2: null });
  });

  it("keeps the Sale's own status once the order is billed", async () => {
    // The widening must not shadow a real settlement: a PAID bill still reads
    // PAID, and a raised-but-unpaid one still reads UNPAID for its own reason.
    const service = serviceWith(
      [order('ord_1', 'COMPLETED', 'sal_1'), order('ord_2', 'COMPLETED', 'sal_2')],
      [
        { id: 'sal_1', paymentStatus: 'PAID', total: 2400 },
        { id: 'sal_2', paymentStatus: 'PARTIAL', total: 900 },
      ],
    );

    expect(await paymentByOrder(service)).toEqual({ ORD_1: 'PAID', ORD_2: 'PARTIAL' });
  });

  it('leaves a third-party row untracked — that money is the platform\'s', async () => {
    const service = serviceWith([], [], [external('ext_1')]);

    expect(await paymentByOrder(service)).toEqual({ EXT_1: null });
  });
});

describe('the Unpaid filter', () => {
  it('finds the unbilled orders it used to skip', async () => {
    const service = serviceWith(
      [
        order('ord_live', 'SUBMITTED'), // no Sale — the row that used to vanish
        order('ord_paid', 'COMPLETED', 'sal_1'),
        order('ord_void', 'CANCELLED'),
      ],
      [{ id: 'sal_1', paymentStatus: 'PAID', total: 2400 }],
      [external('ext_1')],
    );

    const res = await service.listOrders(TENANT, BRANCH, { paymentStatus: 'UNPAID' });

    expect(res.items.map((r) => r.orderNumber)).toEqual(['ORD_LIVE']);
    // The negative half — the filter must still be a filter. A projection that
    // stamped UNPAID everywhere would return all four of these.
    expect(res.total).toBe(1);
  });

  it('still separates a settled bill from an unbilled order', async () => {
    const service = serviceWith(
      [order('ord_live', 'SUBMITTED'), order('ord_paid', 'COMPLETED', 'sal_1')],
      [{ id: 'sal_1', paymentStatus: 'PAID', total: 2400 }],
    );

    const paid = await service.listOrders(TENANT, BRANCH, { paymentStatus: 'PAID' });

    expect(paid.items.map((r) => r.orderNumber)).toEqual(['ORD_PAID']);
  });

  it('leaves the unfiltered queue showing every row', async () => {
    // Guards the filter being applied when it was not asked for — the counts
    // above are only meaningful against a known whole.
    const service = serviceWith(
      [order('ord_live', 'SUBMITTED'), order('ord_void', 'CANCELLED')],
      [],
      [external('ext_1')],
    );

    const res = await service.listOrders(TENANT, BRANCH, {});

    expect(res.total).toBe(3);
  });
});
