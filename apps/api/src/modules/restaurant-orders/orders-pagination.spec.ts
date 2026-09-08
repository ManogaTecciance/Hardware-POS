import { RestaurantOrdersService } from './restaurant-orders.service';

/**
 * `listOrders` paging.
 *
 * The endpoint took a `limit` (default 100) and returned a bare array — a
 * ceiling, not paging. Past the hundredth order nothing was reachable, `total`
 * did not exist, and nothing said the list had been cut.
 *
 * The status and payment filters are DERIVED in TypeScript and search spans
 * joined columns, so none of them can be pushed into the `where`. The service
 * therefore scans what SQL can filter, derives the rest, and pages the result
 * — which makes the ordering, the total and the truncation flag the things
 * worth pinning. Prisma is a stub returning fixed rows, so these assertions are
 * about the paging arithmetic, not about the database.
 */

interface Row {
  id: string;
  createdAt: Date;
  channel: 'DINE_IN' | 'TAKEAWAY';
  status: string;
  session: null;
  items: { menuItemName: string; quantity: number }[];
  rounds: { status: string }[];
  takeawayProfile: null;
  sale: null;
}

function restaurantRow(i: number, at: string): Row {
  return {
    id: 'ord_' + String(i).padStart(3, '0'),
    createdAt: new Date(at),
    channel: 'TAKEAWAY',
    status: 'SUBMITTED',
    session: null,
    items: [{ menuItemName: 'Rice', quantity: 1 }],
    rounds: [],
    takeawayProfile: null,
    sale: null,
  };
}

/** A service wired to a Prisma stub that returns `rows` and no external orders. */
function serviceWith(rows: Row[]) {
  // Typed args so `mock.calls[0][0]` is inspectable — the scan size is one of
  // the things worth asserting.
  const restaurantOrder = { findMany: jest.fn(async (_args: { take: number }) => rows) };
  const externalOrder = { findMany: jest.fn(async (_args: { take: number }) => []) };
  const prisma = { restaurantOrder, externalOrder } as never;
  return {
    service: new RestaurantOrdersService(prisma),
    restaurantFindMany: restaurantOrder.findMany,
  };
}

/** `n` orders, newest first by construction (minute i before minute i-1). */
function manyRows(n: number): Row[] {
  return Array.from({ length: n }, (_, i) =>
    restaurantRow(i, new Date(Date.UTC(2026, 8, 1, 12, 0, 0) - i * 60_000).toISOString()),
  );
}

const TENANT = 'tnt_1';
const BRANCH = 'brn_1';

describe('paging arithmetic', () => {
  it('returns the first page and the true total', async () => {
    const { service } = serviceWith(manyRows(80));

    const res = await service.listOrders(TENANT, BRANCH, {});

    expect(res.items).toHaveLength(25);
    // `total` is the whole filtered set, not the page — the number the pager
    // divides to decide how many pages there are.
    expect(res.total).toBe(80);
    expect(res.page).toBe(1);
    expect(res.pageSize).toBe(25);
  });

  it('continues rather than restarting on the next page', async () => {
    const { service } = serviceWith(manyRows(80));

    const first = await service.listOrders(TENANT, BRANCH, { page: 1 });
    const second = await service.listOrders(TENANT, BRANCH, { page: 2 });

    expect(second.items).toHaveLength(25);
    // No overlap and no gap: page 2 starts exactly where page 1 stopped. A
    // slice computed from the wrong offset would still return 25 rows.
    const firstIds = first.items.map((i) => i.id);
    const secondIds = second.items.map((i) => i.id);
    expect(secondIds.some((id) => firstIds.includes(id))).toBe(false);
    // The rows are built newest-first, so together the two pages must be the
    // first fifty in that order — which catches an off-by-one that skips or
    // repeats a single order at the boundary.
    const allRows = manyRows(80).map((r) => r.id);
    expect([...firstIds, ...secondIds]).toEqual(allRows.slice(0, 50));
  });

  it('returns the remainder on the last page', async () => {
    const { service } = serviceWith(manyRows(80));

    const res = await service.listOrders(TENANT, BRANCH, { page: 4 });

    expect(res.items).toHaveLength(5);
    expect(res.total).toBe(80);
  });

  it('returns an empty page past the end, not an error', async () => {
    const { service } = serviceWith(manyRows(80));

    const res = await service.listOrders(TENANT, BRANCH, { page: 99 });

    // Filters change under a reader who is on page 4; a throw there would
    // surface as a broken screen rather than an empty one.
    expect(res.items).toEqual([]);
    expect(res.total).toBe(80);
  });

  it('clamps a nonsense page and page size instead of slicing with them', async () => {
    const { service } = serviceWith(manyRows(80));

    expect((await service.listOrders(TENANT, BRANCH, { page: 0 })).page).toBe(1);
    expect((await service.listOrders(TENANT, BRANCH, { page: -3 })).page).toBe(1);
    expect((await service.listOrders(TENANT, BRANCH, { pageSize: 0 })).pageSize).toBe(1);
    // Capped, so a client cannot ask for the whole table in one request.
    expect((await service.listOrders(TENANT, BRANCH, { pageSize: 5000 })).pageSize).toBe(100);
  });

  it('honours a caller-chosen page size', async () => {
    const { service } = serviceWith(manyRows(80));

    const res = await service.listOrders(TENANT, BRANCH, { pageSize: 10, page: 3 });

    expect(res.items).toHaveLength(10);
    expect(res.pageSize).toBe(10);
  });
});

describe('ordering', () => {
  it('sorts newest first across the whole set before paging', async () => {
    const { service } = serviceWith(manyRows(80));

    const res = await service.listOrders(TENANT, BRANCH, {});

    const dates = res.items.map((i) => i.createdAt);
    expect([...dates].sort().reverse()).toEqual(dates);
  });

  it('breaks a tie on id, so a row cannot swap pages between requests', async () => {
    /*
     * Three orders created in the same millisecond, and the database hands
     * them back in a different order the second time — which it is free to do,
     * since nothing in the `orderBy` distinguishes them.
     *
     * The differing input order is the whole test. `Array.sort` is stable, so
     * feeding the SAME order twice produces the same output with or without a
     * tie-break, and such a test would pass against either implementation
     * while proving nothing.
     *
     * Without the tie-break the two requests disagree, and a row on the page-1
     * boundary is shown twice or not at all.
     */
    const same = new Date(Date.UTC(2026, 8, 1, 12, 0, 0)).toISOString();
    const rows = [restaurantRow(1, same), restaurantRow(2, same), restaurantRow(3, same)];

    let call = 0;
    const restaurantOrder = {
      findMany: jest.fn(async (_args: { take: number }) => {
        call += 1;
        return call === 1 ? rows : [...rows].reverse();
      }),
    };
    const prisma = {
      restaurantOrder,
      externalOrder: { findMany: jest.fn(async (_args: { take: number }) => []) },
    } as never;
    const service = new RestaurantOrdersService(prisma);

    const a = await service.listOrders(TENANT, BRANCH, { pageSize: 3 });
    const b = await service.listOrders(TENANT, BRANCH, { pageSize: 3 });

    expect(restaurantOrder.findMany).toHaveBeenCalledTimes(2);
    expect(a.items.map((i) => i.id)).toEqual(b.items.map((i) => i.id));
  });
});

describe('the scan ceiling', () => {
  it('does not flag truncation for an ordinary result', async () => {
    const { service } = serviceWith(manyRows(80));

    expect((await service.listOrders(TENANT, BRANCH, {})).truncated).toBe(false);
  });

  it('flags truncation once the scan is capped', async () => {
    // 1001 rows: the scan asks for ceiling + 1 precisely so a complete scan
    // can be told from one that was cut off.
    const { service } = serviceWith(manyRows(1001));

    const res = await service.listOrders(TENANT, BRANCH, {});

    // Told, not hidden — a silently short list is the defect this replaced.
    expect(res.truncated).toBe(true);
    expect(res.items).toHaveLength(25);
  });

  it('asks the database for a bounded scan', async () => {
    const { service, restaurantFindMany } = serviceWith(manyRows(10));

    await service.listOrders(TENANT, BRANCH, {});

    expect(restaurantFindMany).toHaveBeenCalledTimes(1);
    // Ceiling + 1: the extra row is what lets a complete scan be told from a
    // capped one. Asserting the number pins that intent.
    expect(restaurantFindMany.mock.calls[0]![0].take).toBe(1001);
  });
});

describe('status counts', () => {
  it('counts every status, so selecting one tab does not zero the others', async () => {
    const rows = manyRows(30);
    // Half cancelled, so two statuses are populated.
    for (let i = 0; i < 15; i += 1) rows[i]!.status = 'CANCELLED';
    const { service } = serviceWith(rows);

    const res = await service.listOrders(TENANT, BRANCH, { status: 'CANCELLED' });

    expect(res.total).toBe(15);
    expect(res.statusCounts.CANCELLED).toBe(15);
    // The half that matters: counted BEFORE the status filter, so the PENDING
    // tab still shows its 15 while CANCELLED is selected.
    expect(res.statusCounts.PENDING).toBe(15);
  });
});
