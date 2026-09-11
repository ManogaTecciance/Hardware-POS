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
 * - D175 — station and table are STRUCTURED filters, and the search is down to
 *   the THREE things a person would type: ticket number, order number, dish.
 *   Under D152 the station name was the search's fifth leg and this file
 *   pinned it; that assertion is now false by decision and is rewritten here
 *   rather than loosened (D16). The station filter is `stationId: { in }`, the
 *   table filter reaches through `round.order.session.tableId`, and an EMPTY
 *   set is the ABSENCE of the key — an `in: []` is a legal clause that matches
 *   nothing, which is the mutant the empty-set tests exist to catch.
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
 *
 * D152 — and a station, because the history table names one again. The
 * stationless variant is not hypothetical: the column is still nullable and
 * the D147-window tickets were never backfilled, so both shapes reach this
 * read and both are exercised below.
 */
function pendingRow(
  id: string,
  status: 'QUEUED' | 'IN_PROGRESS',
  station: { name: string } | null = { name: 'Grill' },
) {
  return {
    id,
    ticketNumber: `KOT-${id}`,
    branchId: BRANCH,
    roundId: 'rnd_1',
    stationId: station ? 'stn_grill' : null,
    station,
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
      // D152 — the second row carries no station: a ticket cut during the
      // D147 window, which this screen still has to render.
      pendingRow('kt_started', 'IN_PROGRESS', null),
    ]);
    captured.count.mockResolvedValue(2);

    const res = await service.listHistoryForBranch(TENANT, BRANCH, query);

    expect(res.items.map((t) => t.id)).toEqual(['kt_queued', 'kt_started']);
    expect(res.items.map((t) => t.status)).toEqual(['QUEUED', 'IN_PROGRESS']);
    expect(res.items.map((t) => t.completedAt)).toEqual([null, null]);
    expect(res.items.map((t) => t.completedByName)).toEqual([null, null]);
    /*
     * D152 — the station column of the history table, both ways in one
     * assertion: the row that has one is named, the row that has none is
     * null rather than a throw on `row.station.name` or a borrowed 'Grill'.
     */
    expect(res.items.map((t) => t.stationName)).toEqual(['Grill', null]);
    expect(res.items.map((t) => t.stationId)).toEqual(['stn_grill', null]);
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

  it('searches the three things a person would TYPE, case-insensitively (D175)', async () => {
    /*
     * "Five" under D152, "four" under D147 before that, and now THREE by
     * decision: the station-name leg and the tab/table/area leg left the
     * search and became the structured filters pinned below. The count and
     * the leg list are rewritten to the new truth rather than loosened (D16):
     * a `toBeGreaterThan` here would stop noticing a leg that went missing,
     * which is the only failure this test exists to catch.
     */
    const { service, captured } = makeService();

    await service.listHistoryForBranch(TENANT, BRANCH, { ...query, search: 'Lamprais' });

    const or = lastWhere(captured).OR as Record<string, unknown>[];
    const serialised = JSON.stringify(or);
    expect(or).toHaveLength(3);
    // The ticket's own number, the order it belonged to, and what was on it.
    expect(serialised).toContain('ticketNumber');
    expect(serialised).toContain('orderNumber');
    expect(serialised).toContain('menuItemName');
    // Every leg insensitive — a search for "lamprais" must find "Lamprais".
    // Exactly as many as there are legs now: the place leg that was itself an
    // OR of three is gone, so there is no longer a "+2" to explain.
    expect(serialised.match(/insensitive/g)).toHaveLength(or.length);
  });

  it('D175 — the station and table legs are OUT of the search, and the three that remain are exact', async () => {
    /*
     * This test asserted the OPPOSITE under D152 — that the station name was
     * a leg of the search — which was right until the PO asked for station
     * and table to be picked from a list rather than typed. Rewritten to the
     * new truth rather than deleted (D16).
     *
     * The search term is 'Grill', a station name a cook would type, so the
     * negative below is not vacuous: under D152 this exact call produced a
     * station leg, and the structured filter that replaced it is asserted in
     * the SAME test, so "no station leg" cannot pass for a service that had
     * simply lost the station altogether (D30).
     */
    const { service, captured } = makeService();

    await service.listHistoryForBranch(TENANT, BRANCH, {
      ...query,
      search: 'Grill',
      stationIds: ['stn_grill'],
    });

    const where = lastWhere(captured);
    const or = where.OR as Record<string, unknown>[];
    // POSITIVE — the three legs, spelled out and in order, insensitive.
    expect(or).toEqual([
      { ticketNumber: { contains: 'Grill', mode: 'insensitive' } },
      { round: { order: { orderNumber: { contains: 'Grill', mode: 'insensitive' } } } },
      { items: { some: { menuItemName: { contains: 'Grill', mode: 'insensitive' } } } },
    ]);
    // NEGATIVE — no leg reaches the station relation, by name or by id…
    expect(or.filter((leg) => 'station' in leg || 'stationId' in leg)).toEqual([]);
    // …and no leg reaches the session (tab name, table code, area name).
    expect(JSON.stringify(or)).not.toContain('session');
    expect(JSON.stringify(or)).not.toContain('tabName');
    // POSITIVE — where the station went instead: a structured `in` on the id,
    // OUTSIDE the OR, so it narrows the search rather than widening it.
    expect(where.stationId).toEqual({ in: ['stn_grill'] });
  });

  it('MUTATION PROOF — either retired leg creeping back into the search would be caught', async () => {
    /*
     * Two mutants, both built from the OR the SHIPPED service just emitted
     * rather than from a local stand-in, so this proves the assertions above
     * are about the code that runs. Both were also proven against the real
     * source: restoring either leg in the service turns the two tests above
     * red on the exact-legs assertion.
     *
     * Mutant 1: the D152 station-name leg put back. Mutant 2: the tab/table/
     * area leg put back. A `toHaveLength(3)` alone would catch both; the
     * exact-array assertion catches them AND a leg swapped for a different one.
     */
    const { service, captured } = makeService();
    await service.listHistoryForBranch(TENANT, BRANCH, { ...query, search: 'Grill' });
    const shipped = lastWhere(captured).OR as Record<string, unknown>[];

    const withStation = [
      ...shipped,
      { station: { name: { contains: 'Grill', mode: 'insensitive' } } },
    ];
    const withPlace = [
      ...shipped,
      {
        round: {
          order: {
            session: {
              OR: [
                { tabName: { contains: 'Grill', mode: 'insensitive' } },
                { table: { code: { contains: 'Grill', mode: 'insensitive' } } },
                { table: { area: { name: { contains: 'Grill', mode: 'insensitive' } } } },
              ],
            },
          },
        },
      },
    ];

    for (const mutant of [withStation, withPlace]) {
      // The mutation lands — the ORs are genuinely different…
      expect(mutant).not.toEqual(shipped);
      // …and the leg-count assertion the tests above rest on rejects both.
      expect(() => expect(mutant).toHaveLength(3)).toThrow();
    }
    // Each mutant is also caught by the negative aimed at ITS leg…
    expect(() => expect(withStation.filter((leg) => 'station' in leg)).toEqual([])).toThrow();
    expect(() => expect(JSON.stringify(withPlace)).not.toContain('session')).toThrow();
    // …while what actually shipped satisfies all three.
    expect(shipped).toHaveLength(3);
    expect(shipped.filter((leg) => 'station' in leg)).toEqual([]);
    expect(JSON.stringify(shipped)).not.toContain('session');
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

/**
 * The cancellation clauses exactly as D115/D150 left them on the history's
 * `round`, restated here because the table filter is nested INSIDE this
 * object and the tests below must prove it landed beside these rather than
 * in place of them.
 */
const NOT_CANCELLED_ROUND = {
  status: { not: 'CANCELLED' },
  order: {
    status: { not: 'CANCELLED' },
    OR: [{ takeawayProfile: null }, { takeawayProfile: { status: { not: 'CANCELLED' } } }],
  },
};

describe('the ticket history’s structured filters (D175)', () => {
  const query = { page: 1, pageSize: 25, skip: 0, take: 25 };

  it('a station set is `stationId: { in }` on the ticket itself', async () => {
    const { service, captured } = makeService();

    await service.listHistoryForBranch(TENANT, BRANCH, {
      ...query,
      stationIds: ['stn_grill', 'stn_pastry'],
    });

    const where = lastWhere(captured);
    // POSITIVE — the set, verbatim, as an `in` on the column the ticket
    // carries. A D147-window ticket has null there and `IN` never matches
    // null, which is how "in no station's filter" falls out of the clause.
    expect(where.stationId).toEqual({ in: ['stn_grill', 'stn_pastry'] });
    // NEGATIVE — it is a filter, not a search: no OR was built for it…
    expect(where.OR).toBeUndefined();
    // …and the cancellation clauses stand untouched beside it.
    expect(where.round).toEqual(NOT_CANCELLED_ROUND);
    expect(where.tenantId).toBe(TENANT);
    expect(where.branchId).toBe(BRANCH);
  });

  it('a table set reaches through round.order.session.tableId, BESIDE the cancellation clauses', async () => {
    const { service, captured } = makeService();

    await service.listHistoryForBranch(TENANT, BRANCH, {
      ...query,
      tableIds: ['tbl_4', 'tbl_7'],
    });

    const where = lastWhere(captured);
    /*
     * The whole `round` object, not a `.session.tableId` reach: a filter that
     * had been written as a second `round:` key would have REPLACED the
     * cancellation clauses (an object literal keeps the last of two equal
     * keys), and a test that only looked for the table clause would have
     * called that a pass while cancelled work came back onto the screen.
     */
    expect(where.round).toEqual({
      ...NOT_CANCELLED_ROUND,
      order: {
        ...NOT_CANCELLED_ROUND.order,
        session: { tableId: { in: ['tbl_4', 'tbl_7'] } },
      },
    });
    // NEGATIVE — the table axis did not touch the station axis or the search.
    expect('stationId' in where).toBe(false);
    expect(where.OR).toBeUndefined();
  });

  it('both sets at once are AND-ed: the two clauses are both present, each with its own ids', async () => {
    const { service, captured } = makeService();

    await service.listHistoryForBranch(TENANT, BRANCH, {
      ...query,
      stationIds: ['stn_grill'],
      tableIds: ['tbl_4'],
    });

    const where = lastWhere(captured);
    // Distinct ids on each axis, so a filter that wired one set to the other's
    // clause would land here with them crossed.
    expect(where.stationId).toEqual({ in: ['stn_grill'] });
    expect(
      (where.round as { order: { session: { tableId: unknown } } }).order.session.tableId,
    ).toEqual({ in: ['tbl_4'] });
    // Top-level siblings on the same `where` — which is an AND in Prisma — and
    // not two entries of an OR, which would widen the page instead of
    // narrowing it.
    expect(where.OR).toBeUndefined();
    expect(where.AND).toBeUndefined();
  });

  it('an empty set is NO filter on that axis — the key is absent, not `in: []`', async () => {
    /*
     * The difference the screen would notice: `stationId: { in: [] }` is a
     * legal Prisma clause and it matches NOTHING, so a service that spread the
     * clause in unconditionally would answer "Clear filters" with an empty
     * page. Both spellings of absence are asserted, because `toBeUndefined`
     * also passes for a key present and explicitly undefined.
     */
    const { service, captured } = makeService();

    await service.listHistoryForBranch(TENANT, BRANCH, {
      ...query,
      stationIds: [],
      tableIds: [],
    });

    const where = lastWhere(captured);
    expect('stationId' in where).toBe(false);
    expect(where.stationId).toBeUndefined();
    expect(where.round).toEqual(NOT_CANCELLED_ROUND);
    expect('session' in (where.round as { order: object }).order).toBe(false);
    // POSITIVE — and the read is otherwise intact, so this cannot pass for a
    // `where` that collapsed to nothing.
    expect(where.tenantId).toBe(TENANT);
    expect(where.branchId).toBe(BRANCH);
  });

  it('a set left out entirely is the same query as an empty one — byte-for-byte', async () => {
    const { service, captured } = makeService();

    await service.listHistoryForBranch(TENANT, BRANCH, query);
    const omitted = lastWhere(captured);
    await service.listHistoryForBranch(TENANT, BRANCH, { ...query, stationIds: [], tableIds: [] });
    const empty = lastWhere(captured);

    // The client sends nothing for an unfiltered axis and the controller hands
    // the service `undefined`; the page's "Clear filters" may well hand it
    // `[]`. Neither may differ from the read the history made before D175.
    expect(JSON.stringify(empty)).toBe(JSON.stringify(omitted));
    expect(omitted).toEqual({ tenantId: TENANT, branchId: BRANCH, round: NOT_CANCELLED_ROUND });
  });

  it('MUTATION PROOF — an empty set spread in as `in: []` would be caught', async () => {
    /*
     * The mutant: the conditional spread replaced by an unconditional one, so
     * "no filter" arrives at Postgres as `stationId IN ()`. Built on the
     * `where` the SHIPPED service just emitted for an empty set — not on a
     * local stand-in — so this proves the assertion above is about the code
     * that runs. Proven against the real source too: dropping the
     * `length > 0` guard in the service turns the two tests above red.
     */
    const { service, captured } = makeService();
    await service.listHistoryForBranch(TENANT, BRANCH, { ...query, stationIds: [] });
    const shipped = lastWhere(captured);
    const mutant = { ...shipped, stationId: { in: [] } };

    // The mutation lands — genuinely different queries…
    expect(mutant).not.toEqual(shipped);
    // …a loose "is it undefined-ish" check would NOT catch it (a real clause
    // is present), which is why the test above asserts the key's absence…
    expect(() => expect('stationId' in mutant).toBe(false)).toThrow();
    // …while accepting what actually shipped.
    expect('stationId' in shipped).toBe(false);
  });

  it('filters and the search compose: three legs of OR, narrowed by both sets', async () => {
    const { service, captured } = makeService();

    await service.listHistoryForBranch(TENANT, BRANCH, {
      ...query,
      search: 'kottu',
      stationIds: ['stn_grill'],
      tableIds: ['tbl_4'],
    });

    const where = lastWhere(captured);
    expect(where.OR).toHaveLength(3);
    expect(where.stationId).toEqual({ in: ['stn_grill'] });
    expect(
      (where.round as { order: { session: { tableId: unknown } } }).order.session.tableId,
    ).toEqual({ in: ['tbl_4'] });
  });

  it('counts the SAME filtered set it pages', async () => {
    // The D142 sibling above proves this for a search; the filters are new
    // clauses on the same `where` and the pager's promise must hold for them
    // too — a count that forgot the table set would report a total the page
    // could never reach.
    const { service, captured } = makeService();

    await service.listHistoryForBranch(TENANT, BRANCH, {
      ...query,
      stationIds: ['stn_grill'],
      tableIds: ['tbl_4'],
    });

    const paged = (captured.findMany.mock.calls.at(-1)![0] as { where: unknown }).where;
    const counted = (captured.count.mock.calls.at(-1)![0] as { where: unknown }).where;
    expect(counted).toEqual(paged);
    // …and it is the FILTERED set both agree on, not an unfiltered one.
    expect((counted as { stationId: unknown }).stationId).toEqual({ in: ['stn_grill'] });
  });
});
