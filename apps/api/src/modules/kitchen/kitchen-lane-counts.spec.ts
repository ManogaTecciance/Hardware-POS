import { Prisma } from '@hardware-pos/database';

import { KitchenService } from './kitchen.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { SettingsService } from '../settings/settings.service';

/**
 * D154 — one request, one snapshot.
 *
 * The board polls every five seconds and used to spend TWO requests on each
 * tick: the lane's tickets, then the lane counts. This file pins what folding
 * the second into the first is actually worth, which is not the saved request:
 *
 * - **One transaction.** The cards and the chips come from the SAME snapshot,
 *   so a ticket bumped mid-tick can no longer be counted on a chip while its
 *   card is already gone (or the reverse). Two separate reads made that a
 *   matter of timing; one `$transaction` makes it impossible.
 * - **The counts do not vary with `?status=`.** D142b's rule is that every
 *   lane chip carries its number whichever lane is open, so the counts are the
 *   BRANCH's. A count that quietly narrowed to the open lane would leave two
 *   of the three chips reading zero — the bug D142b was raised to fix.
 * - **`GET …/counts` still answers exactly as it did.** It is the cheap read
 *   for a caller that wants three integers rather than every ticket and its
 *   items, and D154 removes callers from it, not the route.
 *
 * HOW THE STUB EARNS ITS ASSERTIONS (D30). Prisma's query builders return
 * *unawaited* `PrismaPromise`s here, so the stub returns descriptors that
 * RECORD what was asked and REFUSE to be awaited: `then` throws. A mutant that
 * issues a count on its own — `await this.prisma.kitchenTicket.count(…)`, the
 * shape of the code before D154 — therefore does not merely differ from what
 * shipped, it rejects. `$transaction` reads each descriptor's value directly,
 * so only queries that go through it can resolve at all.
 *
 * Every count's value is derived from its own `where` rather than handed out
 * in call order, and an unrecognised `where` THROWS: a test that stubbed three
 * equal numbers would pass for a service that mapped `preparing` onto
 * `toMake`, and one that stubbed by position would pass for a service that had
 * stopped counting the lanes D142b named.
 */

const TENANT = 'tnt_1';
const BRANCH = 'brn_1';
/** Deliberately not UTC — the Done lane's window is the shop's day (D142). */
const SHOP_TZ = 'Asia/Colombo';

/** The three lane counts, distinct so a swapped mapping cannot pass. */
const TO_MAKE = 7;
const PREPARING = 3;
const DONE_TODAY = 11;

type Args = { where?: Record<string, unknown> } & Record<string, unknown>;

/** A query that was BUILT. Whether it was RUN, and where, is the assertion. */
interface Issued {
  kind: 'findMany' | 'count';
  args: Args;
  value: unknown;
  then(): never;
}

function issue(kind: Issued['kind'], args: Args, value: unknown): Issued {
  return {
    kind,
    args,
    value,
    /*
     * The load-bearing half of this stub. Every read a board tick makes must
     * travel through `$transaction`; awaiting one directly is precisely the
     * mutation D154 removed, and this turns it into a rejection instead of a
     * silently-passing second round trip that no assertion would notice.
     */
    then(): never {
      throw new Error(`${kind} was awaited outside $transaction`);
    },
  };
}

/**
 * Which lane a count is counting, read off its own `where`.
 *
 * Throwing on anything else is D30 §7 in miniature: if the service stops
 * issuing the three counts D142b defined — renames a status, drops the day
 * window, narrows to the open lane — this stub fails loudly rather than
 * handing back a plausible number and letting the suite stay green.
 */
function countValueFor(args: Args): number {
  const where = (args.where ?? {}) as { status?: unknown; completedAt?: unknown };
  const status = where.status as { notIn?: unknown[] } | string | undefined;
  if (status && typeof status === 'object' && Array.isArray(status.notIn)) return TO_MAKE;
  if (status === 'IN_PROGRESS') return PREPARING;
  if (status === 'COMPLETED' && where.completedAt) return DONE_TODAY;
  throw new Error(
    `unrecognised lane count — this spec would be asserting nothing: ${JSON.stringify(args.where)}`,
  );
}

/** A ticket row exactly as `TICKET_INCLUDE` returns one. */
function ticketRow() {
  return {
    id: 'tkt_1',
    ticketNumber: 'KOT-000027',
    branchId: BRANCH,
    roundId: 'rnd_1',
    stationId: 'stn_grill',
    station: { name: 'Grill' },
    status: 'QUEUED',
    completedAt: null,
    completedBy: null,
    createdAt: new Date('2026-09-10T04:30:00Z'),
    items: [
      {
        id: 'kti_1',
        menuItemName: 'Chicken Wings',
        variantName: null,
        quantity: new Prisma.Decimal(2),
        modifierNames: [],
        specialInstructions: null,
      },
    ],
    round: {
      roundNumber: 1,
      order: {
        orderNumber: 'RO-000026',
        session: { waiterUserId: 'usr_1', tabName: null, table: { code: 'T4', area: null } },
      },
    },
  };
}

function makeService(rows = [ticketRow()]) {
  /** Every query the service BUILT, in build order. */
  const issued: Issued[] = [];
  const $transaction = jest.fn((ops: Issued[]) => Promise.resolve(ops.map((op) => op.value)));
  const userFindMany = jest.fn().mockResolvedValue([{ id: 'usr_1', name: 'Nimal' }]);

  const prisma = {
    kitchenTicket: {
      findMany: (args: Args) => {
        const q = issue('findMany', args, rows);
        issued.push(q);
        return q;
      },
      count: (args: Args) => {
        const q = issue('count', args, countValueFor(args));
        issued.push(q);
        return q;
      },
    },
    user: { findMany: userFindMany },
    $transaction,
  } as unknown as PrismaService;

  const settings = { getSettings: () => ({ timezone: SHOP_TZ }) } as unknown as SettingsService;
  return {
    service: new KitchenService(prisma, settings),
    issued,
    $transaction,
    userFindMany,
    prisma,
  };
}

/**
 * The ops of the n-th transaction the service opened.
 *
 * Throws rather than returning `[]` when there is no such transaction: an
 * assertion made against an empty ops list is the vacuous kind D30 exists to
 * stop — `expect(ops.some(isCount)).toBe(false)` would pass beautifully for a
 * service that had stopped querying altogether.
 */
function opsOf($transaction: jest.Mock, n = 0): Issued[] {
  const call = $transaction.mock.calls[n];
  if (!call) {
    throw new Error(
      `the service opened no transaction #${n} — every assertion below would be vacuous`,
    );
  }
  return call[0] as Issued[];
}

describe('D154 — a board tick is one request and one snapshot', () => {
  it('answers with the envelope: the lane’s tickets AND the branch’s three counts', async () => {
    const { service } = makeService();

    const res = await service.listTicketsForBranch(TENANT, BRANCH, 'OUTSTANDING');

    /*
     * D16 — this read `const rows = await …; expect(rows[0].id)` before D154,
     * and a bare array is now false by decision. Asserted in both directions:
     * the envelope is there AND the array it replaced is not, because a
     * `res.items` check alone would pass for an array that happened to carry
     * an `items` property from nowhere.
     */
    expect(Array.isArray(res)).toBe(false);
    expect(res.items.map((t) => t.id)).toEqual(['tkt_1']);
    // POSITIVE — the cards are fully projected, so "it returned an envelope"
    // cannot be true of a read that lost the tickets on the way into one.
    expect(res.items[0]!.ticketNumber).toBe('KOT-000027');
    expect(res.items[0]!.stationName).toBe('Grill');
    expect(res.counts).toEqual({
      toMake: TO_MAKE,
      preparing: PREPARING,
      doneToday: DONE_TODAY,
    });
  });

  it('takes ONE transaction, holding exactly the lane read and the three counts', async () => {
    const { service, issued, $transaction } = makeService();

    await service.listTicketsForBranch(TENANT, BRANCH, 'OUTSTANDING');

    // POSITIVE — one transaction, and these four queries are what is in it.
    expect($transaction).toHaveBeenCalledTimes(1);
    const ops = opsOf($transaction);
    expect(ops.map((op) => op.kind)).toEqual(['findMany', 'count', 'count', 'count']);
    /*
     * The exact SET, by identity, rather than a count of four (D30 §3): four
     * queries of the right kinds could still be four queries the service built
     * for something else. Every query it built is in this transaction, and the
     * transaction holds nothing it did not build.
     */
    expect(ops).toHaveLength(issued.length);
    for (const op of issued) expect(ops).toContain(op);
    // NEGATIVE — no second snapshot anywhere: nothing was issued outside it.
    expect(issued.filter((q) => !ops.includes(q))).toEqual([]);
  });

  it('MUTATION PROOF — counts read outside the snapshot would be caught, both ways', async () => {
    /*
     * Mutant 1: a count awaited on its own — the pre-D154 shape, and what a
     * refactor that "simplified" the transaction array away would produce.
     * Run against the SHIPPED stub, so this proves the mechanism the tests
     * above rest on, not a local stand-in.
     *
     * Mutant 2: the counts issued in a SECOND transaction. That one resolves
     * happily — it is a legal program — so it is the ASSERTION that has to
     * kill it, and the proof is that the assertion above rejects it while
     * accepting what shipped.
     *
     * Both were also proven against the real source: reverting
     * `listTicketsForBranch` to `await findMany` followed by
     * `await laneCountsForBranch(...)` turns the two tests above red.
     */
    const { service, prisma, $transaction } = makeService();
    await service.listTicketsForBranch(TENANT, BRANCH, 'OUTSTANDING');
    const shipped = opsOf($transaction);

    // Mutant 1 lands as a rejection, not a difference.
    await expect(
      (async () =>
        await prisma.kitchenTicket.count({
          where: { tenantId: TENANT, branchId: BRANCH, status: 'IN_PROGRESS' },
        }))(),
    ).rejects.toThrow(/awaited outside \$transaction/);

    // Mutant 2 lands — a genuinely different program…
    await prisma.$transaction([
      prisma.kitchenTicket.count({
        where: { tenantId: TENANT, branchId: BRANCH, status: 'IN_PROGRESS' },
      }),
    ]);
    expect($transaction).toHaveBeenCalledTimes(2);
    // …and the assertion the test above rests on rejects it…
    expect(() => expect($transaction).toHaveBeenCalledTimes(1)).toThrow();
    // …while what actually shipped still satisfies it.
    expect(shipped.map((op) => op.kind)).toEqual(['findMany', 'count', 'count', 'count']);
  });

  it('reads waiter names AFTER the snapshot, as it always did', async () => {
    /*
     * `TableSession.waiterUserId` carries no relation, so the names are a
     * second query that needs the rows before it knows which users to ask
     * for — it cannot join the transaction and does not need to: a user's
     * name is not what a ticket snapshot is protecting.
     */
    const { service, $transaction, userFindMany } = makeService();

    const res = await service.listTicketsForBranch(TENANT, BRANCH, 'OUTSTANDING');

    expect(userFindMany).toHaveBeenCalledWith({
      where: { id: { in: ['usr_1'] } },
      select: { id: true, name: true },
    });
    expect(res.items[0]!.waiterName).toBe('Nimal');
    // NEGATIVE — and it is not one of the transaction's four queries.
    expect(opsOf($transaction).map((op) => op.kind)).toEqual([
      'findMany',
      'count',
      'count',
      'count',
    ]);
  });
});

describe('D142b — the chips are the BRANCH’s, whichever lane is open', () => {
  /** Every lane the board can be standing on, plus "no filter at all". */
  const FILTERS = [
    undefined,
    'OUTSTANDING',
    'COMPLETED_TODAY',
    'CANCELLED',
    'COMPLETED',
    'IN_PROGRESS',
  ] as const;

  it('the status filter moves the LIST and leaves the counts alone', async () => {
    const { service, $transaction } = makeService();

    for (const filter of FILTERS) {
      await service.listTicketsForBranch(TENANT, BRANCH, filter);
    }

    expect($transaction).toHaveBeenCalledTimes(FILTERS.length);
    const listWheres: unknown[] = [];
    const countWheres: unknown[][] = [];
    for (let i = 0; i < FILTERS.length; i += 1) {
      const ops = opsOf($transaction, i);
      listWheres.push(ops[0]!.args.where);
      countWheres.push(ops.slice(1).map((op) => op.args.where));
    }

    // POSITIVE — the three count queries are identical across every filter.
    // Not "the numbers came out the same": the QUERIES are the same, so no
    // filter can narrow a chip even against data this stub never had.
    for (const wheres of countWheres) expect(wheres).toEqual(countWheres[0]);

    /*
     * NEGATIVE, and the half that makes the positive mean anything: the LIST's
     * `where` genuinely did change for every filter. Without this the test
     * above would pass just as well for a service that ignored `?status=`
     * entirely — six identical queries agree with each other beautifully.
     */
    const distinctLists = new Set(listWheres.map((w) => JSON.stringify(w)));
    expect(distinctLists.size).toBe(FILTERS.length);
  });

  it('counts the three lanes D142b named, and maps them the right way round', async () => {
    const { service, $transaction } = makeService();

    const res = await service.listTicketsForBranch(TENANT, BRANCH, 'CANCELLED');

    const [, toMake, preparing, doneToday] = opsOf($transaction);
    // "To make" is everything outstanding nobody has started…
    expect(toMake!.args.where!.status).toEqual({ notIn: ['COMPLETED', 'IN_PROGRESS'] });
    // …"Preparing" is what somebody has…
    expect(preparing!.args.where!.status).toBe('IN_PROGRESS');
    // …and "Done" is the shop's own day (D142), not everything ever bumped.
    expect(doneToday!.args.where!.status).toBe('COMPLETED');
    const window = doneToday!.args.where!.completedAt as { gte: Date; lt: Date };
    // Colombo is UTC+5:30, so the shop's midnight is 18:30 UTC the day before.
    expect(window.gte.getUTCHours()).toBe(18);
    expect(window.gte.getUTCMinutes()).toBe(30);
    expect(window.lt.getTime() - window.gte.getTime()).toBe(24 * 60 * 60 * 1000);

    /*
     * D115 — both outstanding counts still hold out work that was called off,
     * exactly as the lane they label does. Dropping this from the counts would
     * put a number on a chip that the lane below it refuses to show.
     */
    for (const op of [toMake, preparing]) {
      expect(op!.args.where!.round).toEqual({
        status: { not: 'CANCELLED' },
        order: {
          status: { not: 'CANCELLED' },
          OR: [{ takeawayProfile: null }, { takeawayProfile: { status: { not: 'CANCELLED' } } }],
        },
      });
    }

    /*
     * And the envelope maps each count onto the field that means it. The stub
     * derives every value from the query's own `where`, so a service that
     * swapped two entries of the destructure would land here with them
     * crossed — which three equal stub numbers could never show.
     */
    expect(res.counts).toEqual({
      toMake: TO_MAKE,
      preparing: PREPARING,
      doneToday: DONE_TODAY,
    });
  });

  it('MUTATION PROOF — a count narrowed to the open lane would be caught', async () => {
    /*
     * The mutant: the counts built from the LIST's `where` instead of the
     * branch's lanes — the shortcut that looks like a simplification while the
     * board happens to be standing on Outstanding, and blanks two chips out of
     * three everywhere else. Built from the `where`s the SHIPPED service
     * emitted, so this proves the assertion above is about the code that runs.
     */
    const { service, $transaction } = makeService();
    await service.listTicketsForBranch(TENANT, BRANCH, 'OUTSTANDING');
    await service.listTicketsForBranch(TENANT, BRANCH, 'CANCELLED');

    const onOutstanding = opsOf($transaction, 0).slice(1).map((op) => op.args.where);
    const onCancelled = opsOf($transaction, 1).slice(1).map((op) => op.args.where);
    // What shipped: the same three counts from both lanes.
    expect(onCancelled).toEqual(onOutstanding);

    // The mutant: each count re-scoped to the open lane's `where`.
    const listWhere = opsOf($transaction, 1)[0]!.args.where;
    const mutant = onCancelled.map((w) => ({ ...w, ...listWhere }));

    // It lands — the mutant queries are genuinely different…
    expect(mutant).not.toEqual(onOutstanding);
    // …and the assertion the test above rests on rejects it.
    expect(() => expect(mutant).toEqual(onOutstanding)).toThrow();
  });
});

describe('D154 — the standalone counts route is untouched', () => {
  it('still answers three counts in one transaction, and reads no tickets', async () => {
    const { service, $transaction, userFindMany } = makeService();

    const counts = await service.laneCountsForBranch(TENANT, BRANCH);

    expect(counts).toEqual({
      toMake: TO_MAKE,
      preparing: PREPARING,
      doneToday: DONE_TODAY,
    });
    expect($transaction).toHaveBeenCalledTimes(1);
    const ops = opsOf($transaction);
    expect(ops.map((op) => op.kind)).toEqual(['count', 'count', 'count']);
    /*
     * NEGATIVE — it did not quietly become the board's read. That is the whole
     * point of keeping it: a caller that wants three integers must not be made
     * to fetch every ticket, its items and its waiter to get them.
     */
    expect(ops.some((op) => op.kind === 'findMany')).toBe(false);
    expect(userFindMany).not.toHaveBeenCalled();
  });

  it('counts the same three things the list read counts — one definition, not two', async () => {
    const { service, $transaction } = makeService();

    await service.listTicketsForBranch(TENANT, BRANCH, 'COMPLETED_TODAY');
    await service.laneCountsForBranch(TENANT, BRANCH);

    const fromList = opsOf($transaction, 0).slice(1).map((op) => op.args);
    const fromRoute = opsOf($transaction, 1).map((op) => op.args);
    // POSITIVE — byte-identical arguments, in the same order. Two copies of
    // "what is preparing" is how a chip comes to promise work the lane has not
    // got; D154 extracted them so there is only one copy to get wrong.
    expect(fromRoute).toEqual(fromList);
    // NEGATIVE — and they are three DIFFERENT queries, so the equality above
    // cannot be one query compared with itself three times.
    expect(new Set(fromRoute.map((a) => JSON.stringify(a))).size).toBe(3);
  });
});
