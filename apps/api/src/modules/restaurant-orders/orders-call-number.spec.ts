import { RestaurantOrdersService } from './restaurant-orders.service';

/**
 * D197 — the queue carries the call number, and search finds it EXACTLY.
 *
 * Prisma is a stub returning fixed rows, as in `orders-pagination.spec`: the
 * assertions are about the projection and the search predicate, not the
 * database.
 */
function row(i: number, orderNumber: string, callNumber: number | null) {
  return {
    id: `ord_${i}`,
    createdAt: new Date(Date.UTC(2026, 8, 14, 12, 0, 0) - i * 60_000),
    channel: 'TAKEAWAY' as const,
    status: 'SUBMITTED',
    orderNumber,
    callNumber,
    session: null,
    items: [{ menuItemName: 'Rice', quantity: 1 }],
    rounds: [],
    takeawayProfile: null,
    sale: null,
  };
}

function serviceWith(rows: ReturnType<typeof row>[]) {
  const prisma = {
    restaurantOrder: { findMany: jest.fn(async () => rows) },
    externalOrder: { findMany: jest.fn(async () => []) },
  } as never;
  return new RestaurantOrdersService(prisma);
}

const TENANT = 'tnt_1';
const BRANCH = 'brn_1';

describe('D197 — call number on the queue', () => {
  const rows = [
    row(0, 'RO-000147', 47),
    row(1, 'RO-000140', 4),
    row(2, 'RO-000104', 147),
    // Minted before D197: no call number, reads by its RO- number.
    row(3, 'RO-000047', null),
  ];

  it('every row carries its call number, null where the order predates D197', async () => {
    const res = await serviceWith(rows).listOrders(TENANT, BRANCH, {});
    expect(res.items.map((r) => [r.orderNumber, r.callNumber])).toEqual([
      ['RO-000147', 47],
      ['RO-000140', 4],
      ['RO-000104', 147],
      ['RO-000047', null],
    ]);
  });

  it('"47" finds call number 47 and NOT 147 — and "#47" means the same thing', async () => {
    const service = serviceWith(rows);
    for (const search of ['47', ' 47 ']) {
      const res = await service.listOrders(TENANT, BRANCH, { search });
      // POSITIVE — the exact call number; the substring leg still matches the
      // RO- numbers that CONTAIN "47", which is the pre-D197 behaviour kept.
      expect(res.items.map((r) => r.id)).toEqual(['ord_0', 'ord_3']);
      // NEGATIVE — 147 is not 47.
      expect(res.items.some((r) => r.callNumber === 147)).toBe(false);
    }
    // With the hash the substring leg has nothing to match, so the call
    // number is the ONLY leg that can answer — and it does.
    const hashed = await service.listOrders(TENANT, BRANCH, { search: '#47' });
    expect(hashed.items.map((r) => r.id)).toEqual(['ord_0']);
  });

  it('"4" does not light up every call number containing a 4', async () => {
    const res = await serviceWith(rows).listOrders(TENANT, BRANCH, { search: '4' });
    // Substring still matches the RO- numbers (all four contain a 4), so the
    // proof is on the call-number leg alone: a row whose ONLY match would be
    // "47 contains 4" must not appear. Build one without a 4 in its RO-.
    const only = await serviceWith([row(9, 'RO-000999', 47)]).listOrders(TENANT, BRANCH, {
      search: '4',
    });
    expect(only.items).toHaveLength(0);
    expect(res.items).toHaveLength(4);
  });

  it('MUTATION — with the call-number leg removed, "47" would find only the RO- substring matches', async () => {
    // The row whose RO- number contains no "47" is reachable ONLY through the
    // call-number leg; if it is present, the leg is live.
    const res = await serviceWith([row(5, 'RO-000123', 47)]).listOrders(TENANT, BRANCH, {
      search: '47',
    });
    expect(res.items.map((r) => r.id)).toEqual(['ord_5']);
  });
});
