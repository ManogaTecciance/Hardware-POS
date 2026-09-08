import { DiningService } from './dining.service';
import {
  MemberTableUnavailableError,
  OpenTableInServiceError,
  OpenTableNotFoundError,
  TableInServiceError,
  TableNotFoundError,
  TableNotHeldByOpenTableError,
} from './dining.errors';

/**
 * D49/D50 open-table paths on DiningService under a stubbed Prisma.
 * `$transaction` hands back the same stub so each lock → validate → write
 * sequence executes for real; `$queryRaw` serves the FOR UPDATE lock (result
 * ignored) and the DocumentSequence upsert (reads rows[0].value).
 *
 * The two `findMany` stubs route on the SHAPE of the query rather than call
 * order, so a reordering inside the service does not silently feed a test the
 * wrong rows — which is exactly how a release test could pass while asserting
 * nothing (D30).
 */

type MemberRow = { id: string; code: string; status: string; isActive: boolean; kind: string };

function physical(id: string, code: string, status = 'AVAILABLE'): MemberRow {
  return { id, code, status, isActive: true, kind: 'PHYSICAL' };
}

function openTableRow(over: Record<string, unknown> = {}) {
  return {
    id: 'tbl_open',
    tenantId: 'tnt_1',
    branchId: 'brn_1',
    areaId: null,
    kind: 'OPEN',
    code: 'OPEN-3',
    label: 'Party of six',
    capacity: null,
    positionX: null,
    positionY: null,
    status: 'SEATED',
    isActive: true,
    createdByUserId: 'usr_1',
    openMembers: [],
    ...over,
  };
}

function build(overrides: {
  /** Physical tables the eligibility query resolves. */
  members?: MemberRow[];
  /** memberTableIds the CLOSING open table holds. */
  ownMemberships?: string[];
  /** memberTableId → the still-live open tables holding it after the close. */
  heldBy?: Record<string, Array<{ id: string; code: string; label: string | null }>>;
  openRow?: unknown;
  physicalRow?: unknown;
  liveSession?: unknown;
  /**
   * D104 — live tabs still on the CLOSING open table after its own session
   * went CLOSED. Zero (the default) is the pre-D104 world and keeps every
   * older test meaning exactly what it meant: the last tab out dissolves the
   * arrangement.
   */
  remainingTabs?: number;
  /**
   * D106 — live tabs on the ARRANGEMENTS holding a member, asked by
   * `releaseMemberTable` before it frees anything. Distinct from
   * `remainingTabs`: that one is about the arrangement being closed.
   */
  holderLiveTabs?: number;
  /** D104 — live sessions behind the occupancy figures on a listed arrangement. */
  liveTabs?: Array<{ tableId: string; guestCount: number | null }>;
} = {}) {
  const calls: Record<string, unknown[]> = {
    updateMany: [],
    deleteMany: [],
    update: [],
    raw: [],
    createMany: [],
  };
  const memberIds = overrides.ownMemberships ?? [];
  const heldBy = overrides.heldBy ?? {};

  const prisma: any = {
    $transaction: (fn: (tx: unknown) => unknown) => fn(prisma),
    $queryRaw: jest.fn(async (...args: unknown[]) => {
      calls.raw.push(args);
      return [{ value: 3 }];
    }),
    branch: { findFirst: jest.fn(async () => ({ id: 'brn_1' })) },
    tableSession: {
      findFirst: jest.fn(async () => overrides.liveSession ?? null),
      /*
       * Two different questions reach `count`, so it routes on the SHAPE of
       * the query rather than on call order — the same rule the two
       * `findMany` stubs follow, and for the same reason: a reordering inside
       * the service must not silently feed a test the wrong number.
       *
       *   tableId: '<id>'        → D104, "is anybody else still on THIS
       *                            arrangement", asked by releaseOpenTable.
       *   tableId: { in: [...] } → D106, "is anybody on the arrangements
       *                            holding this member", asked by
       *                            releaseMemberTable.
       */
      count: jest.fn(async (args: { where?: { tableId?: unknown } }) =>
        args?.where?.tableId && typeof args.where.tableId === 'object'
          ? overrides.holderLiveTabs ?? 0
          : overrides.remainingTabs ?? 0,
      ),
      // D104 — the occupancy pass behind liveTabs / seatsTaken.
      findMany: jest.fn(async () => overrides.liveTabs ?? []),
    },
    restaurantTable: {
      findFirst: jest.fn(async (args: { where: Record<string, unknown> }) =>
        args.where.kind === 'OPEN'
          ? (overrides.openRow ?? null)
          : ('physicalRow' in overrides ? overrides.physicalRow : { id: 't2', code: 'T2', label: null }),
      ),
      findMany: jest.fn(async (args: { where: any; select?: any }) => {
        // listOpenTablesById — `id` is a bare string.
        if (typeof args.where?.id === 'string') {
          return [openTableRow({ openMembers: (overrides.members ?? []).map((m) => ({
            memberTable: { id: m.id, code: m.code, label: null, areaId: 'area_1', status: 'RESERVED' },
          })) })];
        }
        // Eligibility probe — asks for status/kind.
        if (args.select?.status) return overrides.members ?? [];
        // Release summary — asks for code/label only.
        return (overrides.members ?? []).map((m) => ({ id: m.id, code: m.code, label: null }));
      }),
      create: jest.fn(async (args: { data: Record<string, unknown> }) => ({
        ...args.data,
        id: 'tbl_open',
        positionX: null,
        positionY: null,
        status: 'AVAILABLE',
        isActive: true,
      })),
      update: jest.fn(async (args: any) => {
        calls.update.push(args);
        return { ...openTableRow(), ...args.data, id: args.where.id, kind: 'PHYSICAL', code: 'T2' };
      }),
      updateMany: jest.fn(async (args: unknown) => {
        calls.updateMany.push(args);
        return { count: 1 };
      }),
    },
    openTableMember: {
      createMany: jest.fn(async (args: unknown) => {
        calls.createMany.push(args);
        return { count: memberIds.length };
      }),
      findMany: jest.fn(async (args: { where: any; select?: any }) => {
        // The closing table's OWN memberships.
        if (args.where?.openTableId) return memberIds.map((memberTableId) => ({ memberTableId }));
        // Remaining live holders of those members…
        if (args.where?.memberTableId?.in) {
          return Object.entries(heldBy).flatMap(([memberTableId, holders]) =>
            args.where.memberTableId.in.includes(memberTableId)
              ? holders.map((openTable) => ({ memberTableId, openTable }))
              : [],
          );
        }
        // …or one specific table's holders (manual release).
        const holders = heldBy[args.where?.memberTableId] ?? [];
        return holders.map((openTable, i) => ({ id: `otm_${i}`, openTable }));
      }),
      deleteMany: jest.fn(async (args: unknown) => {
        calls.deleteMany.push(args);
        return { count: 1 };
      }),
    },
  };
  return { service: new DiningService(prisma), prisma, calls };
}

const TENANT = 'tnt_1';
const BRANCH = 'brn_1';
const ACTOR = 'usr_1';

/** The status a `updateMany` call was setting, for terse assertions. */
function statusUpdates(calls: unknown[], status: string) {
  return (calls as Array<{ where: { id: { in: string[] } }; data: { status: string } }>)
    .filter((c) => c.data?.status === status)
    .flatMap((c) => c.where.id.in);
}

describe('DiningService — open tables (D49/D50)', () => {
  describe('createOpenTable — membership', () => {
    it('joins available physical tables: OPEN kind, auto code, members RESERVED', async () => {
      const { service, prisma, calls } = build({ members: [physical('t4', 'T4'), physical('t2', 'T2')] });

      const view = await service.createOpenTable(TENANT, BRANCH, ACTOR, {
        name: 'Party of six',
        memberTableIds: ['t4', 't2'],
      } as never);

      const firstRaw = (calls.raw as unknown[][])[0];
      expect(JSON.stringify(firstRaw?.[0])).toContain('FOR UPDATE');
      expect(prisma.restaurantTable.create.mock.calls[0][0].data).toMatchObject({
        kind: 'OPEN',
        areaId: null,
        code: 'OPEN-3',
        label: 'Party of six',
        capacity: null,
        createdByUserId: ACTOR,
      });
      expect(statusUpdates(calls.updateMany, 'RESERVED').sort()).toEqual(['t2', 't4']);
      expect(view.members).toHaveLength(2);
    });

    /*
     * D105 supersedes this test's predecessor, which asserted a RESERVED
     * member could be SHARED into a second arrangement (D50's two-unrelated-
     * pairs example). That widening rested on an arrangement meaning exactly
     * one tab; D104 ended it, and a member now stays RESERVED while its
     * arrangement fills with guests — so the rule was offering tables with
     * people sitting at them. The case itself did not disappear: the second
     * pair opens a second TAB on the existing arrangement instead.
     *
     * Asserted as a refusal AND with the write-side negative, because
     * "rejects" alone would also pass against a service that had thrown for an
     * unrelated reason before touching anything.
     *
     * Mutation-proven (D30 §5), measured: restoring
     * `|| member.status === RESERVED` to the eligibility predicate in
     * `createOpenTable` FAILS 2 of this file's 22 tests — this one and the
     * `RESERVED` row of the refusal table below.
     */
    it('D105: a table already inside another open table is refused, not shared', async () => {
      const { service, calls } = build({ members: [physical('t4', 'T4', 'RESERVED')] });
      await expect(
        service.createOpenTable(TENANT, BRANCH, ACTOR, {
          name: 'Second pair',
          memberTableIds: ['t4'],
        } as never),
      ).rejects.toThrow(/Table T4 is not available/);
      expect(statusUpdates(calls.updateMany, 'RESERVED')).toEqual([]);
      expect(calls.createMany).toEqual([]);
    });

    it.each([['OCCUPIED'], ['SEATED'], ['BILLING'], ['CLEANING'], ['BLOCKED'], ['RESERVED']])(
      'refuses a %s member — it is in service or already joined',
      async (status) => {
        const { service } = build({ members: [physical('t4', 'T4'), physical('t2', 'T2', status)] });
        await expect(
          service.createOpenTable(TENANT, BRANCH, ACTOR, {
            name: 'x',
            memberTableIds: ['t4', 't2'],
          } as never),
        ).rejects.toThrow(/Table T2 is not available/);
      },
    );

    it('refuses an archived member and an OPEN-kind member', async () => {
      const archived = build({ members: [{ ...physical('t4', 'T4'), isActive: false }] });
      await expect(
        archived.service.createOpenTable(TENANT, BRANCH, ACTOR, { name: 'x', memberTableIds: ['t4'] } as never),
      ).rejects.toThrow(MemberTableUnavailableError);

      const nested = build({ members: [{ ...physical('t9', 'OPEN-1'), kind: 'OPEN' }] });
      await expect(
        nested.service.createOpenTable(TENANT, BRANCH, ACTOR, { name: 'x', memberTableIds: ['t9'] } as never),
      ).rejects.toThrow(MemberTableUnavailableError);
    });

    it('404s when a requested member does not resolve in this tenant/branch', async () => {
      const { service } = build({ members: [physical('t4', 'T4')] });
      await expect(
        service.createOpenTable(TENANT, BRANCH, ACTOR, {
          name: 'x',
          memberTableIds: ['t4', 'ghost'],
        } as never),
      ).rejects.toThrow(TableNotFoundError);
    });
  });

  describe('releaseOpenTable — last one out (D50)', () => {
    it('releases a member whose LAST membership just went', async () => {
      const { service, calls } = build({
        members: [physical('t4', 'T4'), physical('t2', 'T2')],
        ownMemberships: ['t4', 't2'],
        heldBy: {},
      });
      const tx = (service as unknown as { prisma: unknown }).prisma;

      const summary = await service.releaseOpenTable(tx as never, TENANT, 'tbl_open');

      expect(summary.released.map((t) => t.code).sort()).toEqual(['T2', 'T4']);
      expect(summary.stillReserved).toEqual([]);
      expect(statusUpdates(calls.updateMany, 'AVAILABLE').sort()).toEqual(['t2', 't4']);
    });

    it('leaves a member RESERVED while another open table still holds it', async () => {
      // Example 1: two parties share the four-top; the first bill closes.
      const { service, calls } = build({
        members: [physical('t4', 'T4')],
        ownMemberships: ['t4'],
        heldBy: { t4: [{ id: 'tbl_open_b', code: 'OPEN-4', label: 'Second pair' }] },
      });
      const tx = (service as unknown as { prisma: unknown }).prisma;

      const summary = await service.releaseOpenTable(tx as never, TENANT, 'tbl_open');

      expect(summary.released).toEqual([]);
      expect(summary.stillReserved).toEqual([
        { id: 't4', code: 'T4', label: null, heldBy: [{ id: 'tbl_open_b', code: 'OPEN-4', label: 'Second pair' }] },
      ]);
      // NEGATIVE: the four-top was not freed under the second party.
      expect(statusUpdates(calls.updateMany, 'AVAILABLE')).toEqual([]);
    });

    it('splits a mixed arrangement — frees the unheld, keeps the held', async () => {
      // Example 2: both parties held the four-top AND the two-top; one closes.
      const { service, calls } = build({
        members: [physical('t4', 'T4'), physical('t2', 'T2')],
        ownMemberships: ['t4', 't2'],
        heldBy: { t4: [{ id: 'tbl_open_b', code: 'OPEN-4', label: 'Threes B' }], },
      });
      const tx = (service as unknown as { prisma: unknown }).prisma;

      const summary = await service.releaseOpenTable(tx as never, TENANT, 'tbl_open');

      expect(summary.released.map((t) => t.code)).toEqual(['T2']);
      expect(summary.stillReserved.map((t) => t.code)).toEqual(['T4']);
      expect(statusUpdates(calls.updateMany, 'AVAILABLE')).toEqual(['t2']);
    });

    /*
     * D104 supersedes this test's predecessor, which asserted the arrangement
     * is ALWAYS archived by the closing tab. "Always" was load-bearing under
     * D49's one-arrangement-one-tab model and is wrong once several parties can
     * share an arrangement: the first bill to close must not dissolve the table
     * under the others. The claim is now conditional, and asserted BOTH ways —
     * a single-sided version would pass against a service that never archives
     * at all, which is the opposite failure.
     */
    it('archives the closing open table and drops its own memberships — when it was the LAST tab', async () => {
      const { service, calls, prisma } = build({
        members: [physical('t4', 'T4')],
        ownMemberships: ['t4'],
        heldBy: { t4: [{ id: 'tbl_open_b', code: 'OPEN-4', label: null }] },
        remainingTabs: 0,
      });
      const tx = (service as unknown as { prisma: unknown }).prisma;
      const summary = await service.releaseOpenTable(tx as never, TENANT, 'tbl_open');

      expect((calls.update as Array<{ data: { isActive: boolean } }>).some((c) => c.data.isActive === false)).toBe(true);
      const deletes = prisma.openTableMember.deleteMany.mock.calls[0][0];
      expect(deletes.where).toMatchObject({ openTableId: 'tbl_open', tenantId: TENANT });
      expect(summary.remainingTabs).toBe(0);
    });

    it('D104: leaves the arrangement standing while another party is still on it', async () => {
      const { service, calls, prisma } = build({
        members: [physical('t4', 'T4')],
        ownMemberships: ['t4'],
        remainingTabs: 1,
      });
      const tx = (service as unknown as { prisma: unknown }).prisma;
      const summary = await service.releaseOpenTable(tx as never, TENANT, 'tbl_open');

      // NEGATIVE, and the whole point: nothing at all was written. Not the
      // archive, not the memberships, not one member's status — the second
      // party keeps the tables it is sitting at.
      expect((calls.update as Array<{ data: { isActive?: boolean } }>).some((c) => c.data.isActive === false)).toBe(false);
      expect(prisma.openTableMember.deleteMany).not.toHaveBeenCalled();
      expect(statusUpdates(calls.updateMany, 'AVAILABLE')).toEqual([]);
      // POSITIVE: and it says why, rather than returning an empty summary that
      // reads identically to "a shared four-top freed nothing".
      expect(summary).toEqual({ released: [], stillReserved: [], remainingTabs: 1 });
    });
  });

  describe('releaseMemberTable — manual early release (D50)', () => {
    it('drops every live membership and returns the table to AVAILABLE', async () => {
      const { service, calls } = build({
        physicalRow: { id: 't2', code: 'T2', label: null, kind: 'PHYSICAL', isActive: true },
        heldBy: { t2: [{ id: 'tbl_open_b', code: 'OPEN-4', label: 'Threes B' }] },
      });

      const result = await service.releaseMemberTable(TENANT, BRANCH, 't2');

      expect(result.releasedFrom).toEqual([{ id: 'tbl_open_b', code: 'OPEN-4', label: 'Threes B' }]);
      const statusUpdate = (calls.update as Array<{ data: { status?: string } }>).find(
        (c) => c.data.status === 'AVAILABLE',
      );
      expect(statusUpdate).toBeDefined();
      expect(calls.deleteMany).toHaveLength(1);
    });

    it('REFUSES a table no open table is holding — the PO’s stated failure mode', async () => {
      const { service, calls } = build({
        physicalRow: { id: 't2', code: 'T2', label: null, kind: 'PHYSICAL', isActive: true },
        heldBy: {},
      });
      await expect(service.releaseMemberTable(TENANT, BRANCH, 't2')).rejects.toThrow(
        TableNotHeldByOpenTableError,
      );
      // NEGATIVE: nothing was written — a table reserved for another reason is
      // untouched, not silently flipped to AVAILABLE.
      expect(calls.update).toEqual([]);
      expect(calls.deleteMany).toEqual([]);
    });

    it('D106: refuses while the arrangement holding it has a live tab', async () => {
      /*
       * The bug this closes: the pre-D106 guard read the MEMBER's own
       * sessions, and a joined member never has one — its tab lives on the
       * open-table row — so the refusal could not fire for the case it looked
       * like it covered. It emptied an arrangement that was serving three
       * tabs, leaving eight guests at tables the floor plan had handed back.
       *
       * D50 permitted this deliberately, for compaction between two
       * arrangements sharing furniture; D105 ended that sharing, so the reason
       * went with it. Paired with the success case above, which must stay
       * green or this guard would be indistinguishable from "refuse always".
       *
       * Mutation-proven (D30 §5), measured: deleting the holder probe from
       * `releaseMemberTable` — leaving only the member's own session, which is
       * the pre-D106 code — FAILS 1 of this file's 23 tests (this one) and 2 of
       * the 12 in `open-table-multi-tab.spec.ts`.
       */
      const { service, calls } = build({
        physicalRow: { id: 't2', code: 'T2', label: null, kind: 'PHYSICAL', isActive: true },
        heldBy: { t2: [{ id: 'tbl_open_b', code: 'OPEN-4', label: 'Threes B' }] },
        holderLiveTabs: 1,
      });

      await expect(service.releaseMemberTable(TENANT, BRANCH, 't2')).rejects.toThrow(
        OpenTableInServiceError,
      );
      // NEGATIVE — the membership survives and the table stays RESERVED.
      expect(calls.deleteMany).toEqual([]);
      expect(calls.update).toEqual([]);
    });

    it('404s a table outside this tenant/branch', async () => {
      const { service } = build({ physicalRow: null });
      await expect(service.releaseMemberTable(TENANT, BRANCH, 'ghost')).rejects.toThrow(
        TableNotFoundError,
      );
    });

    it('refuses a table that somehow has its own live session', async () => {
      const { service } = build({
        physicalRow: { id: 't2', code: 'T2', label: null, kind: 'PHYSICAL', isActive: true },
        heldBy: { t2: [{ id: 'tbl_open_b', code: 'OPEN-4', label: null }] },
        liveSession: { id: 'ts_9' },
      });
      await expect(service.releaseMemberTable(TENANT, BRANCH, 't2')).rejects.toThrow(TableInServiceError);
    });
  });

  describe('dissolveOpenTable', () => {
    it('404s an unknown or already-dissolved open table', async () => {
      const { service } = build({ openRow: null });
      await expect(service.dissolveOpenTable(TENANT, BRANCH, 'nope')).rejects.toThrow(
        OpenTableNotFoundError,
      );
    });

    it('refuses while a session is live', async () => {
      const { service } = build({ openRow: openTableRow(), liveSession: { id: 'ts_1' } });
      await expect(service.dissolveOpenTable(TENANT, BRANCH, 'tbl_open')).rejects.toThrow(
        OpenTableInServiceError,
      );
    });

    it('reports each member’s REAL status, not a blanket AVAILABLE (D50)', async () => {
      const openRow = openTableRow({
        openMembers: [
          { memberTable: { id: 't4', code: 'T4', label: null, areaId: 'a', status: 'RESERVED' } },
          { memberTable: { id: 't2', code: 'T2', label: null, areaId: 'a', status: 'RESERVED' } },
        ],
      });
      const { service } = build({
        openRow,
        members: [physical('t4', 'T4'), physical('t2', 'T2')],
        ownMemberships: ['t4', 't2'],
        heldBy: { t4: [{ id: 'tbl_open_b', code: 'OPEN-4', label: null }] },
      });

      const view = await service.dissolveOpenTable(TENANT, BRANCH, 'tbl_open');

      expect(view.isActive).toBe(false);
      const byId = Object.fromEntries(view.members.map((m) => [m.id, m.status]));
      expect(byId).toEqual({ t4: 'RESERVED', t2: 'AVAILABLE' });
      expect(view.release.stillReserved.map((t) => t.code)).toEqual(['T4']);
    });
  });
});
