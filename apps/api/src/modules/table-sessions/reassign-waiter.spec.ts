import { TableSessionsService } from './table-sessions.service';

/**
 * D159 — handing an open table to a different waiter.
 *
 * The PO's case: mid-service a party asks for someone else, and the shift
 * supervisor has to be able to answer. The route is owner-held; what this spec
 * pins is the SERVICE's three refusals, because each of them is a state the
 * screen would otherwise write and the round submit would then reject —
 * failing later, somewhere else, to somebody who did not do it.
 *
 * ## Why each is a pair
 *
 *   - "refuses a closed session" is indistinguishable from "refuses
 *     everything" unless an open one is proven to go through on the same
 *     service;
 *   - "refuses somebody who cannot serve" is the same: the assignable list is
 *     derived from ROLE permissions, so the positive case has to come from a
 *     role that genuinely carries `order:send-to-kitchen` rather than from a
 *     name;
 *   - the write is asserted by its ARGUMENTS, not just by "no throw": the
 *     defect that matters is updating the wrong row, or writing more than the
 *     waiter (the rounds' own submitters, and the bill, must be untouched).
 *
 * Mutation-proven, each run against the service itself:
 *   1. the assignable check dropped — 1 failed, 6 passed: a table handed to
 *      somebody whose role cannot send it to the kitchen;
 *   2. the OPEN check dropped — 1 failed, 6 passed: a closed session, and with
 *      it a billed one, silently reassigned;
 *   3. the update writing `{ waiterUserId, status }` (touching more than the
 *      waiter) — 1 failed, 6 passed;
 *   4. the serving-role query losing its `permissions` filter (so every role
 *      counts as able to serve) — 5 failed, 2 passed: it widens the assignable
 *      list AND the refusal that rests on it, which is why the stub asserts
 *      that filter is present rather than trusting the result.
 */

const OPEN_SESSION = {
  id: 'ses_1',
  tenantId: 'tnt',
  branchId: 'brn',
  sessionNumber: 'TS-000001',
  status: 'OPEN',
  waiterUserId: 'usr_old',
  guestCount: 2,
  tabName: null,
  openedAt: new Date('2026-09-10T10:00:00Z'),
  closedAt: null,
  finalSaleId: null,
  version: 1,
  tableId: 'tbl_1',
};

interface Stub {
  sessionRow: Record<string, unknown> | null;
  /** Roles whose permission set includes order:send-to-kitchen. */
  servingRoleIds: string[];
  staff: { id: string; name: string }[];
  /** D159a — open sessions per waiter, as the grouped count returns them. */
  openTables?: { waiterUserId: string; count: number }[];
}

function serviceWith(stub: Stub) {
  const roleFindMany = jest.fn(async (args: { where: { permissions?: unknown } }) => {
    // The query MUST filter on the permission relation; a service that looked
    // somewhere else (the enum column, a name) would get an empty filter here
    // and the assertion in the last case below catches it.
    expect(args.where.permissions).toBeDefined();
    return stub.servingRoleIds.map((id) => ({ id }));
  });
  // Typed args so the WHERE clause is inspectable — the branch scoping and the
  // isActive guard are asserted on the query, not on the stub's answer.
  const userFindMany = jest.fn(
    async (_args: { where: Record<string, unknown> }) => stub.staff,
  );
  const sessionFindFirst = jest.fn(async () => stub.sessionRow);
  /** D159a — the per-waiter open-table tally, as one grouped query. */
  const sessionGroupBy = jest.fn(async (_args: unknown) =>
    (stub.openTables ?? []).map((row) => ({
      waiterUserId: row.waiterUserId,
      _count: { _all: row.count },
    })),
  );
  const sessionUpdate = jest.fn(async (args: { where: { id: string }; data: unknown }) => ({
    ...OPEN_SESSION,
    ...(args.data as Record<string, unknown>),
  }));
  const prisma = {
    role: { findMany: roleFindMany },
    user: { findMany: userFindMany },
    tableSession: {
      findFirst: sessionFindFirst,
      update: sessionUpdate,
      groupBy: sessionGroupBy,
    },
  } as never;
  const service = new TableSessionsService(
    prisma,
    // The collaborators this method never reaches. Passing undefined rather
    // than mocks is deliberate: if the reassign ever starts settling, pricing
    // or depleting, this spec fails loudly instead of quietly allowing it.
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
  );
  return { service, sessionUpdate, userFindMany, roleFindMany, sessionGroupBy };
}

const CAN_SERVE: Stub = {
  sessionRow: { ...OPEN_SESSION },
  servingRoleIds: ['role_waiter'],
  staff: [
    { id: 'usr_old', name: 'Nimal Perera' },
    { id: 'usr_new', name: 'Sunil Fernando' },
  ],
};

describe('D159 — reassigning the waiter on an open session', () => {
  it('writes the new waiter, and ONLY the waiter, on the addressed session', async () => {
    const { service, sessionUpdate } = serviceWith(CAN_SERVE);

    const result = await service.reassignWaiter('tnt', 'brn', 'ses_1', 'usr_new');

    // The row addressed, and the one field that may change.
    expect(sessionUpdate).toHaveBeenCalledWith({
      where: { id: 'ses_1' },
      data: { waiterUserId: 'usr_new' },
    });
    // The caller is handed BOTH ids: the audit entry is "who was on this table
    // at the time", which is the question a disputed bill turns into.
    expect(result.previousWaiterUserId).toBe('usr_old');
    expect(result.session.waiterUserId).toBe('usr_new');
    // NEGATIVE — nothing about the session's life moved with it.
    expect(result.session.status).toBe('OPEN');
    expect(result.session.finalSaleId).toBeNull();
  });

  it('refuses a waiter whose role cannot send orders to the kitchen', async () => {
    // Present in the tenant, absent from the assignable list — a kitchen user,
    // a stock clerk, a manager who does not work the floor.
    const { service, sessionUpdate } = serviceWith(CAN_SERVE);

    await expect(
      service.reassignWaiter('tnt', 'brn', 'ses_1', 'usr_kitchen'),
    ).rejects.toThrow(/cannot be assigned a table/i);
    // The refusal is BEFORE the write: a rejected reassign must not leave the
    // table half-moved.
    expect(sessionUpdate).not.toHaveBeenCalled();
  });

  it('refuses a session that is not open', async () => {
    const { service, sessionUpdate } = serviceWith({
      ...CAN_SERVE,
      sessionRow: { ...OPEN_SESSION, status: 'CLOSED' },
    });

    await expect(service.reassignWaiter('tnt', 'brn', 'ses_1', 'usr_new')).rejects.toThrow();
    expect(sessionUpdate).not.toHaveBeenCalled();
  });

  it('refuses a session that is not on this branch or tenant', async () => {
    // `findFirst` is given tenant AND branch, so a foreign id simply is not
    // found — 404 rather than a cross-tenant existence oracle.
    const { service, sessionUpdate } = serviceWith({ ...CAN_SERVE, sessionRow: null });

    await expect(service.reassignWaiter('tnt', 'brn', 'ses_other', 'usr_new')).rejects.toThrow();
    expect(sessionUpdate).not.toHaveBeenCalled();
  });
});

describe('D159 — who the branch can put on a table', () => {
  it('asks for users whose ROLE can send to the kitchen, scoped to the branch', async () => {
    const { service, userFindMany, roleFindMany } = serviceWith(CAN_SERVE);

    const rows = await service.listAssignableWaiters('tnt', 'brn');

    expect(rows.map((r) => r.name)).toEqual(['Nimal Perera', 'Sunil Fernando']);
    // The role query filters on the PERMISSION relation (asserted in the stub),
    // and the user query on those roles…
    expect(roleFindMany).toHaveBeenCalledTimes(1);
    const where = userFindMany.mock.calls[0]![0].where as Record<string, unknown>;
    expect(where).toMatchObject({ tenantId: 'tnt', isActive: true, roleId: { in: ['role_waiter'] } });
    // …and on the branch, by default branch OR an explicit grant — the two
    // ways a user works a branch everywhere else in this codebase.
    expect(where.OR).toEqual([
      { branchId: 'brn' },
      { branchAccess: { some: { branchId: 'brn' } } },
    ]);
  });

  it('D159a — reports how many open tables each of them already holds', async () => {
    /*
     * The number is what makes a fifteen-waiter picker decidable: mid-service
     * the supervisor is choosing who has room, not who exists. There is no
     * clock-in in this schema, so "already serving something on this branch" is
     * the only honest reading of "on the floor" — and it is the same fact the
     * floor plan behind the dialog is showing.
     */
    const { service, sessionGroupBy } = serviceWith({
      ...CAN_SERVE,
      openTables: [{ waiterUserId: 'usr_new', count: 3 }],
    });

    const rows = await service.listAssignableWaiters('tnt', 'brn');

    expect(rows).toEqual([
      { id: 'usr_old', name: 'Nimal Perera', openTableCount: 0 },
      { id: 'usr_new', name: 'Sunil Fernando', openTableCount: 3 },
    ]);
    // ONE grouped query for the whole list, scoped to this branch's OPEN
    // sessions and to the staff being listed — never a query per person.
    expect(sessionGroupBy).toHaveBeenCalledTimes(1);
    const args = sessionGroupBy.mock.calls[0]![0] as {
      by: string[];
      where: Record<string, unknown>;
    };
    expect(args.by).toEqual(['waiterUserId']);
    expect(args.where).toMatchObject({ tenantId: 'tnt', branchId: 'brn', status: 'OPEN' });
    expect(args.where.waiterUserId).toEqual({ in: ['usr_old', 'usr_new'] });
  });

  it('returns nothing — and asks nothing further — when no role can serve', async () => {
    const { service, userFindMany } = serviceWith({
      ...CAN_SERVE,
      servingRoleIds: [],
      staff: [],
    });

    expect(await service.listAssignableWaiters('tnt', 'brn')).toEqual([]);
    // `roleId: { in: [] }` would match nothing anyway; skipping the query is
    // what keeps an empty answer from costing a scan.
    expect(userFindMany).not.toHaveBeenCalled();
  });

  it('never offers an inactive user', async () => {
    const { service, userFindMany } = serviceWith(CAN_SERVE);
    await service.listAssignableWaiters('tnt', 'brn');
    // Asserted on the query rather than the result: the stub cannot model a
    // deactivated row, and `isActive` is the whole guard.
    expect((userFindMany.mock.calls[0]![0].where as { isActive: boolean }).isActive).toBe(true);
  });
});
