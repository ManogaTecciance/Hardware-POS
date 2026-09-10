import { Prisma } from '@hardware-pos/database';
import { lastNDaysInTimeZone } from '@hardware-pos/shared';

import { KitchenService } from './kitchen.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { SettingsService } from '../settings/settings.service';

/**
 * D142 — the Done lane is today's, and the history is everything.
 *
 * Two claims, and each is only worth anything with its opposite beside it:
 *
 * - `COMPLETED_TODAY` cuts on the SHOP's midnight. A window cut on the server's
 *   would be silently wrong by the offset — for a Colombo kitchen on a UTC
 *   host, five and a half hours of last night's tickets stay on the lane every
 *   morning and today's first hours are missing from it. The negative half is
 *   that plain `COMPLETED` still carries no date bound at all: the KDS route,
 *   a bookmarked query and the history screen all still mean "ever".
 * - The history pages and searches in SQL, and TODAY'S TICKETS ARE IN IT. A
 *   test that only asserted "old tickets appear" would also pass for a screen
 *   that excluded today, which is the one thing the brief calls out.
 * - D150 — the history holds UNFINISHED tickets too. It narrowed to
 *   `COMPLETED`, so a ticket still To make or Preparing was on no row of the
 *   screen. The positive is that the emitted `where` carries no `status` key
 *   at all; the negative, in the same test, is that no `completedAt` clause
 *   crept in with the widening. Asserting only the absence of `status` would
 *   pass just as well against a `where` that had collapsed to nothing.
 *
 * Prisma is a stub and the assertions are about the QUERY the service issues —
 * the ladder, the window and the paging arithmetic — not about the database.
 * What the database does with those clauses is pinned by
 * `test/integration/specs/kitchen-board.spec.ts` against real rows.
 */

const TENANT = 'tnt_1';
const BRANCH = 'brn_1';
/** The product's default, and deliberately NOT UTC: an offset zone is the only
 *  kind that can tell a shop-midnight cut from a server-midnight one. */
const SHOP_TZ = 'Asia/Colombo';

type Captured = { findMany: jest.Mock; count: jest.Mock };

function makeService(tz = SHOP_TZ): { service: KitchenService; captured: Captured } {
  const findMany = jest.fn().mockResolvedValue([]);
  const count = jest.fn().mockResolvedValue(0);
  const prisma = {
    kitchenTicket: { findMany, count },
    user: { findMany: jest.fn().mockResolvedValue([]) },
    // The history read issues its page and its count as one transaction; the
    // stub runs the array it is handed, exactly as Prisma's batch form does.
    $transaction: (ops: unknown[]) => Promise.all(ops),
  } as unknown as PrismaService;
  const settings = {
    getSettings: () => ({ timezone: tz }),
  } as unknown as SettingsService;
  return { service: new KitchenService(prisma, settings), captured: { findMany, count } };
}

/**
 * A row as the history's `include` returns it for a ticket nobody has bumped:
 * no `completedAt`, no completer, no session behind it. D150 put these rows in
 * front of the read model for the first time.
 */
function pendingRow(id: string, status: 'QUEUED' | 'IN_PROGRESS') {
  return {
    id,
    ticketNumber: `KOT-${id}`,
    branchId: BRANCH,
    roundId: 'rnd_1',
    stationId: null,
    status,
    completedAt: null,
    completedBy: null,
    createdAt: new Date('2026-09-10T04:00:00.000Z'),
    items: [],
    round: null,
  };
}

/** The `where` of the last `findMany` the service issued. */
function lastWhere(captured: Captured): Prisma.KitchenTicketWhereInput {
  const call = captured.findMany.mock.calls.at(-1);
  if (!call)
    throw new Error('the service issued no query — every assertion below would be vacuous');
  return (call[0] as { where: Prisma.KitchenTicketWhereInput }).where;
}

describe('the Done lane is cut on the shop’s day (D142)', () => {
  it('bounds COMPLETED_TODAY by the shop’s midnight, not the server’s', async () => {
    const { service, captured } = makeService();

    await service.listTicketsForBranch(TENANT, BRANCH, 'COMPLETED_TODAY');

    const where = lastWhere(captured);
    const window = where.completedAt as { gte: Date; lt: Date };
    expect(where.status).toBe('COMPLETED');
    expect(window.gte).toBeInstanceOf(Date);
    // Colombo is UTC+5:30, so its midnight is 18:30 UTC the day before. This is
    // the signature of a shop-midnight cut: a server-midnight one lands on
    // 00:00 UTC, and the mutation proof below shows that difference is caught.
    expect(window.gte.getUTCHours()).toBe(18);
    expect(window.gte.getUTCMinutes()).toBe(30);
    // Half-open, one day wide: `lt`, so a ticket bumped at exactly tomorrow's
    // midnight belongs to tomorrow.
    expect(window.lt.getTime() - window.gte.getTime()).toBe(24 * 60 * 60 * 1000);
    expect(window.lt).toEqual(lastNDaysInTimeZone(1, SHOP_TZ).to);
  });

  it('MUTATION PROOF — a window cut on the server’s midnight would be detected', async () => {
    /*
     * The mutant: `new Date()` with the UTC hours zeroed — what a service that
     * never read the tenant's zone would produce. Compared against the window
     * the SHIPPED service actually emitted, not against a local stand-in, so
     * this proves the assertions above are about the code that runs.
     */
    const { service, captured } = makeService();
    await service.listTicketsForBranch(TENANT, BRANCH, 'COMPLETED_TODAY');
    const shopWindow = lastWhere(captured).completedAt as { gte: Date };

    const naive = new Date();
    naive.setUTCHours(0, 0, 0, 0);

    // The mutation lands — the two are genuinely different instants…
    expect(shopWindow.gte.getTime()).not.toBe(naive.getTime());
    // …and the assertion the other tests rest on rejects the mutant.
    expect(() => expect(naive.getUTCHours()).toBe(18)).toThrow();
    expect(shopWindow.gte.getUTCHours()).toBe(18);
  });

  it('a UTC shop gets UTC midnight — the zone is read, not assumed', async () => {
    const { service, captured } = makeService('UTC');

    await service.listTicketsForBranch(TENANT, BRANCH, 'COMPLETED_TODAY');

    const window = lastWhere(captured).completedAt as { gte: Date };
    expect(window.gte.getUTCHours()).toBe(0);
    expect(window.gte.getUTCMinutes()).toBe(0);
  });

  it('NEGATIVE — plain COMPLETED is still unbounded, so nothing else narrowed', async () => {
    const { service, captured } = makeService();

    await service.listTicketsForBranch(TENANT, BRANCH, 'COMPLETED');

    const where = lastWhere(captured);
    expect(where.status).toBe('COMPLETED');
    expect(where.completedAt).toBeUndefined();
  });

  it('NEGATIVE — the outstanding lane never grew a date bound either', async () => {
    const { service, captured } = makeService();

    await service.listTicketsForBranch(TENANT, BRANCH, 'OUTSTANDING');

    const where = lastWhere(captured);
    expect(where.completedAt).toBeUndefined();
    expect(where.status).toEqual({ not: 'COMPLETED' });
  });

  it('sorts the day by when the food was FINISHED, not when the ticket was raised', async () => {
    const { service, captured } = makeService();

    await service.listTicketsForBranch(TENANT, BRANCH, 'COMPLETED_TODAY');

    // The lane means "what have we finished today", so `createdAt` had it
    // backwards: a ticket raised at 11:00 and bumped at 14:00 belongs above one
    // raised at 13:00 and bumped at 13:30.
    const args = captured.findMany.mock.calls.at(-1)![0] as { orderBy: unknown };
    expect(args.orderBy).toEqual([{ completedAt: 'desc' }, { id: 'desc' }]);
  });

  it('NEGATIVE — the unscoped COMPLETED list keeps the order it always had', async () => {
    const { service, captured } = makeService();

    await service.listTicketsForBranch(TENANT, BRANCH, 'COMPLETED');

    // Nothing that reads `?status=COMPLETED` today sees its order change.
    const args = captured.findMany.mock.calls.at(-1)![0] as { orderBy: { createdAt: string } };
    expect(args.orderBy).toEqual({ createdAt: 'desc' });
  });

  it('NEGATIVE — the outstanding queue is still oldest-first', async () => {
    const { service, captured } = makeService();

    await service.listTicketsForBranch(TENANT, BRANCH, 'OUTSTANDING');

    const args = captured.findMany.mock.calls.at(-1)![0] as { orderBy: { createdAt: string } };
    expect(args.orderBy).toEqual({ createdAt: 'asc' });
  });
});

describe('the ticket history (D142)', () => {
  const query = { page: 1, pageSize: 25, skip: 0, take: 25 };

  it('pages in SQL and returns the standard envelope', async () => {
    const { service, captured } = makeService();
    captured.count.mockResolvedValue(80);

    const res = await service.listHistoryForBranch(TENANT, BRANCH, {
      page: 3,
      pageSize: 20,
      skip: 40,
      take: 20,
    });

    const args = captured.findMany.mock.calls.at(-1)![0] as { skip: number; take: number };
    expect(args.skip).toBe(40);
    expect(args.take).toBe(20);
    expect(res).toEqual({ items: [], total: 80, page: 3, pageSize: 20 });
  });

  it('includes TODAY and every lane — no date bound, and no status bound (D150)', async () => {
    const { service, captured } = makeService();

    await service.listHistoryForBranch(TENANT, BRANCH, query);

    const where = lastWhere(captured);
    // The point of the screen: the Done lane drops a ticket at midnight and
    // this list must still hold it — AND must already hold the one bumped a
    // minute ago. A `completedAt` clause here would break one or the other.
    expect(where.completedAt).toBeUndefined();
    /*
     * D150 — this line asserted `status === 'COMPLETED'`, which is now false by
     * decision rather than by regression: that clause is what kept To make and
     * Preparing off the screen entirely. Rewritten to the new truth, and
     * POSITIVELY: the key is ABSENT from the query, so a queued or in-progress
     * ticket is inside the set this `where` describes. Both spellings, because
     * `toBeUndefined` also passes for a key present and explicitly undefined —
     * which Prisma treats as "no filter" but which would mean the service was
     * still computing one.
     */
    expect('status' in where).toBe(false);
    expect(where.status).toBeUndefined();
    // …and the scoping the widening must NOT have taken with it, so none of
    // the above can pass against a `where` that collapsed to nothing.
    expect(where.tenantId).toBe(TENANT);
    expect(where.branchId).toBe(BRANCH);
    expect(where.round).toBeDefined();
  });

  it('MUTATION PROOF — a status narrowing creeping back would be detected', async () => {
    /*
     * The mutant: `status: 'COMPLETED'`, the clause D150 removed, put back on
     * the `where` the SHIPPED service just emitted — not on a local stand-in,
     * so this proves the assertions above are about the code that runs. Proven
     * against the real source too: restoring that line in the service and
     * running this spec turns the test above red.
     */
    const { service, captured } = makeService();
    await service.listHistoryForBranch(TENANT, BRANCH, query);
    const shipped = lastWhere(captured);
    const mutant = { ...shipped, status: 'COMPLETED' };

    // The mutation lands — the two queries are genuinely different…
    expect(mutant).not.toEqual(shipped);
    // …and the assertion the test above rests on rejects the mutant…
    expect(() => expect('status' in mutant).toBe(false)).toThrow();
    // …while accepting what actually shipped.
    expect('status' in shipped).toBe(false);
  });

  it('D150 — a pending ticket survives the read model, badge and all', async () => {
    /*
     * The `where` is only half the fix. The rows the widened query now returns
     * have a null `completedAt` and no completer, and the table renders a
     * status badge from every row and "—" for both nulls — so the view mapping
     * is asserted here on exactly those rows rather than assumed. Nothing in
     * the mapping had to change; that is the claim, and it is worth pinning,
     * because a mapping that threw on a null completer would turn the fix into
     * a 500 on the same screen.
     */
    const { service, captured } = makeService();
    captured.findMany.mockResolvedValue([
      pendingRow('kt_queued', 'QUEUED'),
      pendingRow('kt_started', 'IN_PROGRESS'),
    ]);
    captured.count.mockResolvedValue(2);

    const res = await service.listHistoryForBranch(TENANT, BRANCH, query);

    expect(res.items.map((t) => t.id)).toEqual(['kt_queued', 'kt_started']);
    expect(res.items.map((t) => t.status)).toEqual(['QUEUED', 'IN_PROGRESS']);
    expect(res.items.map((t) => t.completedAt)).toEqual([null, null]);
    expect(res.items.map((t) => t.completedByName)).toEqual([null, null]);
    expect(res.total).toBe(2);
  });

  it('D150 — unfinished work first, then newest-finished, with a total tiebreak', async () => {
    const { service, captured } = makeService();

    await service.listHistoryForBranch(TENANT, BRANCH, query);

    const args = captured.findMany.mock.calls.at(-1)![0] as { orderBy: unknown };
    /*
     * This asserted `[{ completedAt: 'desc' }, { id: 'desc' }]` and is now
     * false by decision: with D150 the list holds tickets that have NO
     * `completedAt` to sort by, and where those land is the whole ordering
     * question. `nulls: 'first'` is the load-bearing half — the list pages
     * twenty at a time, so a ticket still on the pass, sorted by when it was
     * raised, would sit three pages back, which is exactly the ticket the
     * screen was asked to surface. `createdAt` orders the pending block
     * newest-raised first (they share a null key and would otherwise be
     * arbitrary), and `id` keeps the order total so a page boundary can
     * neither repeat nor skip a row.
     */
    expect(args.orderBy).toEqual([
      { completedAt: { sort: 'desc', nulls: 'first' } },
      { createdAt: 'desc' },
      { id: 'desc' },
    ]);
  });

  it('NEGATIVE — the Done LANE is untouched: still today-only, still two keys', async () => {
    /*
     * D142 draws the line D150 must not cross. The board's lane is the shop's
     * own day and orders by two keys; only the HISTORY widened. Asserted here,
     * beside the change, because "nothing else moved" is the easiest half of
     * this fix to lose — and it is asserted POSITIVELY (the window and the
     * order are what they were) rather than as an absence.
     */
    const { service, captured } = makeService();

    await service.listTicketsForBranch(TENANT, BRANCH, 'COMPLETED_TODAY');

    const args = captured.findMany.mock.calls.at(-1)![0] as { orderBy: unknown; where: unknown };
    expect(args.orderBy).toEqual([{ completedAt: 'desc' }, { id: 'desc' }]);
    const where = args.where as Prisma.KitchenTicketWhereInput;
    expect(where.status).toBe('COMPLETED');
    expect(where.completedAt).toEqual({ gte: expect.any(Date), lt: expect.any(Date) });
  });

  it('excludes work that was called off, like the Done lane (D115)', async () => {
    const { service, captured } = makeService();

    await service.listHistoryForBranch(TENANT, BRANCH, query);

    const round = lastWhere(captured).round as {
      status: { not: string };
      order: { status: { not: string }; OR: Record<string, unknown>[] };
    };
    expect(round.status).toEqual({ not: 'CANCELLED' });
    expect(round.order.status).toEqual({ not: 'CANCELLED' });
    /*
     * The THIRD leg, and D150 is what made it matter. A cancelled takeaway
     * whose ticket was never bumped used to be held out for free by the
     * `status: COMPLETED` clause — it was not COMPLETED, so it could not
     * appear. Widening the read to every lane removed that cover, and this
     * clause became the only thing keeping a called-off takeaway off the
     * screen.
     *
     * Asserted as the exact pair rather than "some takeaway clause exists":
     * dropping `{ takeawayProfile: null }` alone would silently exclude every
     * DINE-IN ticket, which is most of them, and a loose check would not
     * notice.
     */
    expect(round.order.OR).toEqual([
      { takeawayProfile: null },
      { takeawayProfile: { status: { not: 'CANCELLED' } } },
    ]);
  });

  it('searches the four things a person remembers, case-insensitively', async () => {
    const { service, captured } = makeService();

    await service.listHistoryForBranch(TENANT, BRANCH, { ...query, search: 'Lamprais' });

    const or = lastWhere(captured).OR as Record<string, unknown>[];
    const serialised = JSON.stringify(or);
    expect(or).toHaveLength(4);
    // The ticket's own number, the order it belonged to, where it was going,
    // and what was on it.
    expect(serialised).toContain('ticketNumber');
    expect(serialised).toContain('orderNumber');
    expect(serialised).toContain('tabName');
    expect(serialised).toContain('menuItemName');
    // Every leg insensitive — a search for "lamprais" must find "Lamprais".
    // Two more than there are legs because the place leg is itself an OR of
    // three: tab name, table code, area name.
    expect(serialised.match(/insensitive/g)).toHaveLength(or.length + 2);
  });

  it('D147 — no longer searches by station name, and the other legs are untouched', async () => {
    /*
     * The station leg came off with the per-station split: a ticket cut since
     * D147 belongs to no station, so a fifth leg would only ever match the
     * tickets raised before it — a search that quietly means something
     * different depending on the ticket's age.
     *
     * The negative is worthless on its own (D30): "station" is absent from a
     * `where` that searches NOTHING just as surely as from the right one, and
     * the shape of the four surviving legs is asserted above and re-asserted
     * here, so this cannot pass by the OR having collapsed.
     */
    const { service, captured } = makeService();

    await service.listHistoryForBranch(TENANT, BRANCH, { ...query, search: 'Grill' });

    const or = lastWhere(captured).OR as Record<string, unknown>[];
    const serialised = JSON.stringify(or);
    // POSITIVE — a term that used to be matched as a station name is still
    // matched everywhere else, so the search itself is alive.
    expect(or).toHaveLength(4);
    expect(or[0]).toEqual({ ticketNumber: { contains: 'Grill', mode: 'insensitive' } });
    expect(serialised).toContain('menuItemName');
    // NEGATIVE — and nowhere among those four does it reach a station.
    expect(serialised).not.toContain('station');
    expect(or.some((leg) => 'station' in leg)).toBe(false);
  });

  it('NEGATIVE — no search term means no OR clause, not an OR that matches nothing', async () => {
    const { service, captured } = makeService();

    await service.listHistoryForBranch(TENANT, BRANCH, query);

    expect(lastWhere(captured).OR).toBeUndefined();
  });

  it('a blank search is no search — whitespace never becomes a filter', async () => {
    const { service, captured } = makeService();

    await service.listHistoryForBranch(TENANT, BRANCH, { ...query, search: '   ' });

    expect(lastWhere(captured).OR).toBeUndefined();
  });

  it('counts the SAME set it pages, so the pager cannot promise a page that is not there', async () => {
    const { service, captured } = makeService();

    await service.listHistoryForBranch(TENANT, BRANCH, { ...query, search: 'kottu' });

    const paged = (captured.findMany.mock.calls.at(-1)![0] as { where: unknown }).where;
    const counted = (captured.count.mock.calls.at(-1)![0] as { where: unknown }).where;
    expect(counted).toEqual(paged);
  });
});
