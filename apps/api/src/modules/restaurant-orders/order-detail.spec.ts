import { Prisma } from '@hardware-pos/database';

import { RestaurantOrdersService } from './restaurant-orders.service';

/**
 * `getOrderDetail` — the full record behind one queue row.
 *
 * The list deliberately ships thin rows (it is polled every 8 s); the drawer
 * fetches this instead. What is worth pinning:
 *
 * - Line totals are Decimal arithmetic over the SNAPSHOTS
 *   ((unitPrice + modifierTotal) × quantity), not a re-read of menu prices.
 * - The delivery destination is parsed out of the `[Delivery]` notes
 *   workaround here, once — paired with a plain-notes case, because a parser
 *   that returned the whole notes string as an address would pass the
 *   positive case alone.
 * - The timeline speaks the unified vocabulary and is merged from the
 *   history table plus the takeaway profile's handover instant, oldest
 *   first.
 * - An unknown id is null, not a throw — the queue polls under the open
 *   drawer and an archived row must degrade, not error.
 *
 * Prisma is a stub returning fixed rows; assertions are about projection and
 * arithmetic, not the database.
 */

const TENANT = 'tnt_1';
const BRANCH = 'brn_1';

const D = (v: string | number) => new Prisma.Decimal(v);

function takeawayOrderRow(overrides: { notes?: string | null } = {}) {
  return {
    id: 'ord_1',
    channel: 'TAKEAWAY',
    orderNumber: 'RO-000028',
    status: 'COMPLETED',
    createdAt: new Date('2026-09-03T10:50:00Z'),
    rounds: [{ status: 'DELIVERED' }],
    session: { finalSaleId: 'sal_1', table: null },
    takeawayProfile: {
      status: 'HANDED_OVER',
      customerName: 'lahiru',
      customerPhone: '0766727512',
      pickupAt: null,
      handoverAt: new Date('2026-09-03T10:56:00Z'),
      notes: overrides.notes !== undefined ? overrides.notes : '[Delivery] 12 Galle Rd, Colombo',
    },
    items: [
      {
        menuItemName: 'Garden Salad',
        variantNameSnapshot: null,
        quantity: D(1),
        unitPrice: D('650.00'),
        modifierTotal: D('65.00'),
        specialInstructions: null,
        modifiers: [{ optionName: 'Extra dressing', groupName: 'Add-ons', priceDelta: D('65.00') }],
      },
    ],
  };
}

const SALE = {
  id: 'sal_1',
  paymentStatus: 'PAID',
  subtotal: D('715.00'),
  totalDiscount: D(0),
  serviceChargeAmount: D(0),
  packagingCharge: D(0),
  taxAmount: D(0),
  total: D('715.00'),
  paidAmount: D('715.00'),
  balanceAmount: D(0),
  payments: [
    {
      method: 'CASH',
      amount: D('715.00'),
      reference: null,
      createdAt: new Date('2026-09-03T10:57:00Z'),
    },
  ],
};

const HISTORY = [
  { toStatus: 'SUBMITTED', createdAt: new Date('2026-09-03T10:51:00Z') },
  { toStatus: 'COMPLETED', createdAt: new Date('2026-09-03T10:57:30Z') },
];

function serviceWith(stubs: {
  order?: unknown;
  sale?: unknown;
  history?: unknown[];
  external?: unknown;
}) {
  const prisma = {
    restaurantOrder: { findFirst: jest.fn(async () => stubs.order ?? null) },
    sale: { findFirst: jest.fn(async () => stubs.sale ?? null) },
    restaurantOrderStatusHistory: { findMany: jest.fn(async () => stubs.history ?? []) },
    externalOrder: { findFirst: jest.fn(async () => stubs.external ?? null) },
  } as never;
  return new RestaurantOrdersService(prisma);
}

describe('line items and financials', () => {
  it('prices each line from the snapshots and mirrors the settled sale', async () => {
    const service = serviceWith({ order: takeawayOrderRow(), sale: SALE, history: HISTORY });

    const res = await service.getOrderDetail(TENANT, BRANCH, 'ord_1');

    expect(res).not.toBeNull();
    // (650.00 + 65.00) × 1 — Decimal arithmetic over the frozen snapshot,
    // which is also the one place a modifier's money becomes visible.
    expect(res!.items).toEqual([
      expect.objectContaining({
        name: 'Garden Salad',
        quantity: '1',
        unitPrice: '650.00',
        modifierTotal: '65.00',
        lineTotal: '715.00',
        modifiers: [{ optionName: 'Extra dressing', groupName: 'Add-ons', priceDelta: '65.00' }],
      }),
    ]);
    expect(res!.financials).toEqual(
      expect.objectContaining({ subtotal: '715.00', total: '715.00', balanceAmount: '0.00' }),
    );
    expect(res!.payments).toEqual([
      expect.objectContaining({ method: 'CASH', amount: '715.00' }),
    ]);
  });

  it('returns null financials when no sale has settled the order', async () => {
    const open = takeawayOrderRow();
    open.session = { finalSaleId: null, table: null } as never;
    const service = serviceWith({ order: open, history: [] });

    const res = await service.getOrderDetail(TENANT, BRANCH, 'ord_1');

    expect(res!.financials).toBeNull();
    expect(res!.payments).toEqual([]);
  });
});

describe('the delivery-notes workaround', () => {
  it('parses the destination out and keeps it off the notes', async () => {
    const service = serviceWith({ order: takeawayOrderRow(), sale: SALE });

    const res = await service.getOrderDetail(TENANT, BRANCH, 'ord_1');

    expect(res!.deliveryAddress).toBe('12 Galle Rd, Colombo');
    expect(res!.notes).toBeNull();
  });

  it('passes plain notes through untouched', async () => {
    // The half that proves the parser is not just splitting every string:
    // notes without the marker are notes, and no address is invented.
    const service = serviceWith({ order: takeawayOrderRow({ notes: 'Ring the bell twice' }), sale: SALE });

    const res = await service.getOrderDetail(TENANT, BRANCH, 'ord_1');

    expect(res!.deliveryAddress).toBeNull();
    expect(res!.notes).toBe('Ring the bell twice');
  });
});

describe('the timeline', () => {
  it('merges history and the handover instant into unified statuses, oldest first', async () => {
    const service = serviceWith({ order: takeawayOrderRow(), sale: SALE, history: HISTORY });

    const res = await service.getOrderDetail(TENANT, BRANCH, 'ord_1');

    // SUBMITTED (10:51) → handoverAt (10:56) → COMPLETED (10:57:30). The
    // handover row comes from the profile, not the history table — takeaway
    // transitions are never written there, and a timeline built from history
    // alone would omit the one instant a takeaway operator cares about.
    expect(res!.timeline).toEqual([
      { at: '2026-09-03T10:51:00.000Z', status: 'PENDING' },
      { at: '2026-09-03T10:56:00.000Z', status: 'HANDED_OVER' },
      { at: '2026-09-03T10:57:30.000Z', status: 'COMPLETED' },
    ]);
  });
});

describe('channels and misses', () => {
  it('projects a third-party order from its events, with no items or financials', async () => {
    const service = serviceWith({
      external: {
        id: 'ext_1',
        externalOrderRef: 'UE-9911',
        status: 'DELIVERED',
        receivedAt: new Date('2026-09-03T09:00:00Z'),
        externalTotal: D('2400.00'),
        platform: { kind: 'MOCK' },
        events: [
          { toStatus: 'ACCEPTED', createdAt: new Date('2026-09-03T09:01:00Z') },
          { toStatus: 'DELIVERED', createdAt: new Date('2026-09-03T09:40:00Z') },
        ],
      },
    });

    const res = await service.getOrderDetail(TENANT, BRANCH, 'ext_1');

    expect(res!.channel).toBe('THIRD_PARTY');
    expect(res!.items).toEqual([]);
    expect(res!.financials).toBeNull();
    expect(res!.timeline).toEqual([
      { at: '2026-09-03T09:01:00.000Z', status: 'CONFIRMED' },
      { at: '2026-09-03T09:40:00.000Z', status: 'HANDED_OVER' },
    ]);
  });

  it('returns null for an id neither table knows', async () => {
    const service = serviceWith({});

    expect(await service.getOrderDetail(TENANT, BRANCH, 'ord_gone')).toBeNull();
  });
});
