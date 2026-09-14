import { RestaurantOrdersService } from './restaurant-orders.service';

/**
 * D157 — "whose orders", on the queue the floor actually works from.
 *
 * The Orders screen has always shown every order on the branch with no way to
 * find your own, which is the gap the PO reported: a waiter mid-service wants
 * the four tickets that are theirs, not the room's forty. The scope is resolved
 * HERE rather than in the client because the list is paged — a client-side
 * filter would narrow one page of twenty-five and call it the total — and
 * because only the server can count the caller's rows in time to pick the
 * default on a first load.
 *
 * ## Why each case is a pair
 *
 * Every failure mode here is silent:
 *
 *   - attribution reversed (round submitter before the table's waiter) still
 *     produces a name on every row, just the wrong person's, so the dine-in
 *     case asserts the waiter WITH a round submitted by somebody else;
 *   - a default that always widened would look identical to a waiter who
 *     happens to have no tables, so both directions are asserted on the same
 *     service;
 *   - a scope applied to the rows but not to the tallies would leave the status
 *     tabs counting orders the list is not showing — a filter that reads as
 *     broken — so the counts are asserted against the page they describe.
 *
 * Mutation-proven, each run against the service itself:
 *   1. attribution reading the round submitter BEFORE the table's waiter —
 *      4 failed, 5 passed (it moves who owns a dine-in row, so the default
 *      scope and the counts move with it);
 *   2. `resolvedScope` defaulting to `'all'` — 1 failed, 8 passed: a waiter
 *      opens on the whole room, which is the report that started D157;
 *   3. the status tallies computed on the unscoped base — 1 failed, 8 passed:
 *      tabs that count rows the list is not showing;
 *   4. `allCount` reported from the scoped list — 3 failed, 6 passed: the All
 *      chip would echo the Mine number and the two views would look identical.
 *
 * One mutation was DISCARDED as not a defect: computing `mineCount` from the
 * scoped list rather than the base. Narrowing to "mine" keeps exactly the
 * caller's rows, so the two counts are equal by construction — the spec not
 * failing there is correct, and a case written to "catch" it would have been
 * asserting arithmetic rather than behaviour.
 */

const WAITER = 'usr_waiter';
const OTHER = 'usr_other';

interface Row {
  id: string;
  createdAt: Date;
  channel: 'DINE_IN' | 'TAKEAWAY';
  orderNumber: string;
  status: string;
  session: {
    tabName: string | null;
    waiterUserId: string | null;
    finalSaleId: string | null;
    table: { code: string; label: string | null } | null;
  } | null;
  items: { menuItemName: string; quantity: number }[];
  rounds: { status: string; submittedByUserId: string | null }[];
  takeawayProfile: {
    status: string;
    customerName: string | null;
    customerPhone: string | null;
    pickupAt: Date | null;
  } | null;
}

let seq = 0;
const at = () => new Date(Date.UTC(2026, 8, 10, 12, 0, 0) - (seq += 1) * 60_000);

/** A dine-in order on a table served by `waiterUserId`. */
function dineIn(id: string, waiterUserId: string | null, roundBy = OTHER): Row {
  return {
    id,
    createdAt: at(),
    channel: 'DINE_IN',
    orderNumber: id.toUpperCase(),
    status: 'SUBMITTED',
    session: {
      tabName: null,
      waiterUserId,
      finalSaleId: null,
      table: { code: 'T1', label: 'Table one' },
    },
    items: [{ menuItemName: 'Kottu', quantity: 1 }],
    /*
     * Submitted by SOMEBODY ELSE on purpose: a colleague covering the table
     * keys a round, and the order still belongs to the waiter serving it. This
     * is what makes the attribution order testable rather than incidental.
     */
    rounds: [{ status: 'SUBMITTED', submittedByUserId: roundBy }],
    takeawayProfile: null,
  };
}

/** A takeaway order, which has no session — the submitter is the attribution. */
function takeaway(id: string, submittedBy: string | null): Row {
  return {
    id,
    createdAt: at(),
    channel: 'TAKEAWAY',
    orderNumber: id.toUpperCase(),
    status: 'SUBMITTED',
    session: null,
    items: [{ menuItemName: 'Rice', quantity: 2 }],
    rounds: [{ status: 'SUBMITTED', submittedByUserId: submittedBy }],
    takeawayProfile: {
      status: 'PLACED',
      customerName: 'Guest',
      customerPhone: null,
      pickupAt: null,
    },
  };
}

interface ExternalRow {
  id: string;
  receivedAt: Date;
  externalOrderRef: string;
  status: string;
  externalTotal: null;
  platform: { kind: string };
}

function external(id: string): ExternalRow {
  return {
    id,
    receivedAt: at(),
    externalOrderRef: 'UE-' + id,
    status: 'RECEIVED',
    externalTotal: null,
    platform: { kind: 'UBER_EATS' },
  };
}

function serviceWith(rows: Row[], externals: ExternalRow[] = []) {
  const userFindMany = jest.fn(async (args: { where: { id: { in: string[] } } }) =>
    args.where.id.in.map((id) => ({
      id,
      name: id === WAITER ? 'Nimal Perera' : 'Sunil Fernando',
    })),
  );
  const prisma = {
    restaurantOrder: { findMany: async () => rows },
    externalOrder: { findMany: async () => externals },
    sale: { findMany: async () => [] },
    user: { findMany: userFindMany },
  } as never;
  return { service: new RestaurantOrdersService(prisma), userFindMany };
}

describe('D157 — whose orders the queue shows', () => {
  it('attributes a dine-in order to the table\'s waiter, not the round\'s sender', async () => {
    const { service } = serviceWith([dineIn('ord_a', WAITER, OTHER)]);
    const page = await service.listOrders('tnt', 'brn', { scope: 'all' }, WAITER);

    const row = page.items[0]!;
    // POSITIVE — the waiter serving the table…
    expect(row.staffUserId).toBe(WAITER);
    expect(row.staffName).toBe('Nimal Perera');
    // …NEGATIVE — and not the colleague who keyed the round while covering.
    expect(row.staffUserId).not.toBe(OTHER);
  });

  it('attributes a takeaway order to whoever keyed it', async () => {
    const { service } = serviceWith([takeaway('ord_t', OTHER)]);
    const page = await service.listOrders('tnt', 'brn', { scope: 'all' }, WAITER);

    // No session exists on a takeaway order, so the round's submitter is the
    // only honest answer — and it must not fall through to null.
    expect(page.items[0]!.staffUserId).toBe(OTHER);
    expect(page.items[0]!.staffName).toBe('Sunil Fernando');
  });

  it('attributes a third-party order to nobody', async () => {
    const { service } = serviceWith([], [external('x1')]);
    const page = await service.listOrders('tnt', 'brn', { scope: 'all' }, WAITER);

    // A platform order has no person behind it. Attributing it to the reader
    // would put rows in "my orders" that nobody on the floor took.
    expect(page.items[0]!.staffUserId).toBeNull();
    expect(page.items[0]!.staffName).toBeNull();
    // And it is therefore invisible under "mine", while still being counted in
    // the branch total.
    const mine = await service.listOrders('tnt', 'brn', { scope: 'mine' }, WAITER);
    expect(mine.items).toHaveLength(0);
    expect(mine.allCount).toBe(1);
  });

  it('opens on MY orders when the caller has any', async () => {
    const { service } = serviceWith(
      [dineIn('ord_mine', WAITER), takeaway('ord_theirs', OTHER)],
      // A third-party row in the mix: it belongs to nobody, so it counts
      // towards the branch total and never towards "mine".
      [external('x1')],
    );
    // No scope asked for — a waiter arriving on the tab.
    const page = await service.listOrders('tnt', 'brn', {}, WAITER);

    expect(page.resolvedScope).toBe('mine');
    expect(page.items.map((r) => r.id)).toEqual(['ord_mine']);
    // Both chips can still name their size.
    expect(page.mineCount).toBe(1);
    expect(page.allCount).toBe(3);
    // `total` is the SCOPED total, so the pager counts the list on screen.
    expect(page.total).toBe(1);
  });

  it('D157b — stays on MINE when the caller has none, and says how many exist', async () => {
    const { service } = serviceWith([dineIn('ord_theirs', OTHER), takeaway('ord_t', OTHER)]);
    const page = await service.listOrders('tnt', 'brn', {}, WAITER);

    /*
     * This used to widen itself — `mineCount > 0 ? 'mine' : 'all'` — on the
     * reasoning that an empty queue reads as a broken one. The count only
     * exists after the request, so the screen answered "mine" and then moved
     * to "all" a beat later, which the PO reported as working backward. An
     * empty list is the honest answer; `allCount` is what lets the screen
     * offer the way over instead of taking it.
     */
    expect(page.resolvedScope).toBe('mine');
    expect(page.items).toHaveLength(0);
    expect(page.mineCount).toBe(0);
    // NEGATIVE — and it is not an empty BRANCH. The two rows are still there,
    // still counted, one tap away.
    expect(page.allCount).toBe(2);
  });

  it('lets an explicit scope win in both directions', async () => {
    const { service } = serviceWith([dineIn('ord_mine', WAITER), takeaway('ord_theirs', OTHER)]);

    // Asking for everything while owning one: the poll must not pull the
    // reader back to their own rows.
    const all = await service.listOrders('tnt', 'brn', { scope: 'all' }, WAITER);
    expect(all.resolvedScope).toBe('all');
    expect(all.items).toHaveLength(2);

    // Asking for mine while owning none: an honest empty list, still labelled
    // "mine", rather than a silent widening.
    const none = await service.listOrders('tnt', 'brn', { scope: 'mine' }, OTHER + '_nobody');
    expect(none.resolvedScope).toBe('mine');
    expect(none.items).toHaveLength(0);
    expect(none.allCount).toBe(2);
  });

  it('counts the status tabs over the SCOPED list, so the tabs match the rows', async () => {
    const { service } = serviceWith([
      dineIn('ord_mine', WAITER),
      dineIn('ord_theirs1', OTHER),
      dineIn('ord_theirs2', OTHER),
    ]);
    const mine = await service.listOrders('tnt', 'brn', { scope: 'mine' }, WAITER);

    const tabTotal = Object.values(mine.statusCounts).reduce((a, b) => a + b, 0);
    // The tab row sums to the list it sits above — three rows exist, one is
    // shown, and the tabs say one.
    expect(tabTotal).toBe(1);
    expect(mine.items).toHaveLength(1);

    // NEGATIVE CONTROL — the same service, unscoped, counts all three: the
    // assertion above is about the scope, not about a tally that is always 1.
    const all = await service.listOrders('tnt', 'brn', { scope: 'all' }, WAITER);
    expect(Object.values(all.statusCounts).reduce((a, b) => a + b, 0)).toBe(3);
  });

  it('resolves the names in ONE query, for the distinct ids only', async () => {
    const { service, userFindMany } = serviceWith(
      [dineIn('ord_1', WAITER), dineIn('ord_2', WAITER), takeaway('ord_3', OTHER)],
      [external('x1')],
    );
    await service.listOrders('tnt', 'brn', { scope: 'all' }, WAITER);

    // The queue polls every 8 s: a lookup per row would multiply this read by
    // the covers in the room.
    expect(userFindMany).toHaveBeenCalledTimes(1);
    const ids = userFindMany.mock.calls[0]![0].where.id.in;
    expect([...ids].sort()).toEqual([OTHER, WAITER].sort());
    // Tenant-scoped, so a shared user id cannot leak a name across tenants.
    expect(userFindMany.mock.calls[0]![0]).toMatchObject({ where: { tenantId: 'tnt' } });
  });

  it('asks for no names at all when nothing is attributed', async () => {
    const { service, userFindMany } = serviceWith([], [external('x1'), external('x2')]);
    const page = await service.listOrders('tnt', 'brn', {}, WAITER);

    // A third-party-only branch must not spend a query resolving nobody.
    expect(userFindMany).not.toHaveBeenCalled();
    expect(page.items.every((r) => r.staffName === null)).toBe(true);
  });
});
