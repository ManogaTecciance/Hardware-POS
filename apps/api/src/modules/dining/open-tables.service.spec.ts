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
    tableSession: { findFirst: jest.fn(async () => overrides.liveSession ?? null) },
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

    it('D50: a table already RESERVED by another open table can be shared', async () => {
      // Two unrelated pairs on one four-top — the PO's first worked example.
      const { service, calls } = build({ members: [physical('t4', 'T4', 'RESERVED')] });
      await expect(
        service.createOpenTable(TENANT, BRANCH, ACTOR, {
          name: 'Second pair',
          memberTableIds: ['t4'],
        } as never),
      ).resolves.toMatchObject({ code: 'OPEN-3' });
      expect(statusUpdates(calls.updateMany, 'RESERVED')).toEqual(['t4']);
    });

    it.each([['OCCUPIED'], ['SEATED'], ['BILLING'], ['CLEANING'], ['BLOCKED']])(
      'still refuses a %s member — a party is physically there',
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

    it('always archives the closing open table and drops only its own memberships', async () => {
      const { service, calls, prisma } = build({
        members: [physical('t4', 'T4')],
        ownMemberships: ['t4'],
        heldBy: { t4: [{ id: 'tbl_open_b', code: 'OPEN-4', label: null }] },
      });
      const tx = (service as unknown as { prisma: unknown }).prisma;
      await service.releaseOpenTable(tx as never, TENANT, 'tbl_open');

      expect((calls.update as Array<{ data: { isActive: boolean } }>).some((c) => c.data.isActive === false)).toBe(true);
      const deletes = prisma.openTableMember.deleteMany.mock.calls[0][0];
      expect(deletes.where).toMatchObject({ openTableId: 'tbl_open', tenantId: TENANT });
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
