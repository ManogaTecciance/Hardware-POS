import { Prisma } from '@hardware-pos/database';
import { lastNDaysInTimeZone } from '@hardware-pos/shared';

import { KitchenService } from './kitchen.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { SettingsService } from '../settings/settings.service';

/**
 * D138 — the Done lane is today's, and the history is everything.
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

/** The `where` of the last `findMany` the service issued. */
function lastWhere(captured: Captured): Prisma.KitchenTicketWhereInput {
  const call = captured.findMany.mock.calls.at(-1);
  if (!call)
    throw new Error('the service issued no query — every assertion below would be vacuous');
  return (call[0] as { where: Prisma.KitchenTicketWhereInput }).where;
}

describe('the Done lane is cut on the shop’s day (D138)', () => {
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

describe('the ticket history (D138)', () => {
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

  it('includes TODAY — the history carries no date bound at all', async () => {
    const { service, captured } = makeService();

    await service.listHistoryForBranch(TENANT, BRANCH, query);

    const where = lastWhere(captured);
    // The point of the screen: the Done lane drops a ticket at midnight and
    // this list must still hold it — AND must already hold the one bumped a
    // minute ago. A `completedAt` clause here would break one or the other.
    expect(where.completedAt).toBeUndefined();
    expect(where.status).toBe('COMPLETED');
    expect(where.tenantId).toBe(TENANT);
    expect(where.branchId).toBe(BRANCH);
  });

  it('orders by when the food was done, with a tiebreak so pages cannot repeat a row', async () => {
    const { service, captured } = makeService();

    await service.listHistoryForBranch(TENANT, BRANCH, query);

    const args = captured.findMany.mock.calls.at(-1)![0] as { orderBy: Record<string, string>[] };
    expect(args.orderBy).toEqual([{ completedAt: 'desc' }, { id: 'desc' }]);
  });

  it('excludes work that was called off, like the Done lane (D115)', async () => {
    const { service, captured } = makeService();

    await service.listHistoryForBranch(TENANT, BRANCH, query);

    const round = lastWhere(captured).round as {
      status: { not: string };
      order: { status: { not: string } };
    };
    expect(round.status).toEqual({ not: 'CANCELLED' });
    expect(round.order.status).toEqual({ not: 'CANCELLED' });
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

  it('D143 — no longer searches by station name, and the other legs are untouched', async () => {
    /*
     * The station leg came off with the per-station split: a ticket cut since
     * D143 belongs to no station, so a fifth leg would only ever match the
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
