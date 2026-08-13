import { DiningService } from './dining.service';
import {
  MemberTableUnavailableError,
  OpenTableInServiceError,
  OpenTableNotFoundError,
  TableNotFoundError,
} from './dining.errors';

/**
 * D49 open-table paths on DiningService under a stubbed Prisma. `$transaction`
 * hands back the same stub so the lock → validate → create → reserve sequence
 * executes for real; `$queryRaw` serves the FOR UPDATE lock (result ignored)
 * and the DocumentSequence upsert (reads rows[0].value).
 */

type MemberRow = {
  id: string;
  code: string;
  status: string;
  isActive: boolean;
  kind: string;
};

function physical(id: string, code: string, status = 'AVAILABLE'): MemberRow {
  return { id, code, status, isActive: true, kind: 'PHYSICAL' };
}

function build(overrides: {
  members?: MemberRow[];
  openRow?: unknown;
  liveSession?: unknown;
} = {}) {
  const calls: Record<string, unknown[]> = { updateMany: [], deleteMany: [], update: [], raw: [] };
  const prisma: any = {
    $transaction: (fn: (tx: unknown) => unknown) => fn(prisma),
    $queryRaw: jest.fn(async (...args: unknown[]) => {
      calls.raw.push(args);
      return [{ value: 3 }];
    }),
    branch: { findFirst: jest.fn(async () => ({ id: 'brn_1' })) },
    restaurantTable: {
      findMany: jest.fn(async (args: { where: Record<string, unknown> }) =>
        'kind' in (args.where ?? {}) || 'id' in (args.where ?? {})
          ? (overrides.members ?? [])
          : [],
      ),
      findFirst: jest.fn(async () => overrides.openRow ?? null),
      create: jest.fn(async (args: { data: Record<string, unknown> }) => ({
        ...args.data,
        id: 'tbl_open',
        positionX: null,
        positionY: null,
        status: 'AVAILABLE',
        isActive: true,
      })),
      update: jest.fn(async (args: unknown) => {
        calls.update.push(args);
        return {};
      }),
      updateMany: jest.fn(async (args: unknown) => {
        calls.updateMany.push(args);
        return { count: 1 };
      }),
    },
    openTableMember: {
      createMany: jest.fn(async () => ({ count: 2 })),
      findMany: jest.fn(async () => [{ memberTableId: 't4' }, { memberTableId: 't2' }]),
      deleteMany: jest.fn(async (args: unknown) => {
        calls.deleteMany.push(args);
        return { count: 2 };
      }),
    },
    tableSession: { findFirst: jest.fn(async () => overrides.liveSession ?? null) },
  };
  // createOpenTable re-reads the row for the members view after the txn.
  prisma.restaurantTable.findMany.mockImplementation(async (args: { where: Record<string, unknown> }) => {
    if (args.where && 'id' in args.where && typeof args.where.id === 'string') {
      return [
        {
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
          status: 'AVAILABLE',
          isActive: true,
          createdByUserId: 'usr_1',
          openMembers: (overrides.members ?? []).map((m) => ({
            memberTable: { id: m.id, code: m.code, label: null, areaId: 'area_1', status: 'RESERVED' },
          })),
        },
      ];
    }
    return overrides.members ?? [];
  });
  return { service: new DiningService(prisma), prisma, calls };
}

const TENANT = 'tnt_1';
const BRANCH = 'brn_1';
const ACTOR = 'usr_1';

describe('DiningService — open tables (D49)', () => {
  describe('createOpenTable', () => {
    it('joins available physical tables: OPEN kind, auto code, members RESERVED', async () => {
      const members = [physical('t4', 'T4'), physical('t2', 'T2')];
      const { service, prisma, calls } = build({ members });

      const view = await service.createOpenTable(TENANT, BRANCH, ACTOR, {
        name: 'Party of six',
        memberTableIds: ['t4', 't2'],
      } as never);

      // The lock ran before anything was written.
      const firstRaw = (calls.raw as unknown[][])[0];
      expect(JSON.stringify(firstRaw?.[0])).toContain('FOR UPDATE');
      const created = prisma.restaurantTable.create.mock.calls[0][0].data;
      expect(created).toMatchObject({
        kind: 'OPEN',
        areaId: null,
        code: 'OPEN-3',
        label: 'Party of six',
        capacity: null,
        createdByUserId: ACTOR,
      });
      // Both members were reserved in the same transaction.
      const reserve = calls.updateMany.find(
        (c: any) => c.data?.status === 'RESERVED',
      ) as { where: { id: { in: string[] } } };
      expect(reserve.where.id.in.sort()).toEqual(['t2', 't4']);
      expect(view.members).toHaveLength(2);
    });

    it('records seats when the operator supplies them', async () => {
      const { service, prisma } = build({ members: [physical('t4', 'T4')] });
      await service.createOpenTable(TENANT, BRANCH, ACTOR, {
        name: 'Terrace pair',
        seats: 6,
        memberTableIds: ['t4'],
      } as never);
      expect(prisma.restaurantTable.create.mock.calls[0][0].data.capacity).toBe(6);
    });

    it('409s naming the code when a member is not AVAILABLE', async () => {
      const members = [physical('t4', 'T4'), physical('t2', 'T2', 'OCCUPIED')];
      const { service } = build({ members });
      await expect(
        service.createOpenTable(TENANT, BRANCH, ACTOR, {
          name: 'x',
          memberTableIds: ['t4', 't2'],
        } as never),
      ).rejects.toThrow(/Table T2 is not available/);
    });

    it('refuses joining an OPEN table into another open table', async () => {
      const members = [{ ...physical('t9', 'OPEN-1'), kind: 'OPEN' }];
      const { service } = build({ members });
      await expect(
        service.createOpenTable(TENANT, BRANCH, ACTOR, { name: 'x', memberTableIds: ['t9'] } as never),
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

  describe('dissolveOpenTable', () => {
    const openRow = {
      id: 'tbl_open',
      tenantId: TENANT,
      branchId: BRANCH,
      areaId: null,
      kind: 'OPEN',
      code: 'OPEN-3',
      label: 'Party of six',
      capacity: null,
      positionX: null,
      positionY: null,
      status: 'SEATED',
      isActive: true,
      createdByUserId: ACTOR,
      openMembers: [
        { memberTable: { id: 't4', code: 'T4', label: null, areaId: 'a', status: 'RESERVED' } },
      ],
    };

    it('404s an unknown or already-dissolved open table', async () => {
      const { service } = build({ openRow: null });
      await expect(service.dissolveOpenTable(TENANT, BRANCH, 'nope')).rejects.toThrow(
        OpenTableNotFoundError,
      );
    });

    it('refuses while a session is live', async () => {
      const { service } = build({ openRow, liveSession: { id: 'ts_1' } });
      await expect(service.dissolveOpenTable(TENANT, BRANCH, 'tbl_open')).rejects.toThrow(
        OpenTableInServiceError,
      );
    });

    it('releases members, deletes memberships, archives the row', async () => {
      const { service, calls } = build({ openRow });
      const view = await service.dissolveOpenTable(TENANT, BRANCH, 'tbl_open');

      const release = calls.updateMany.find(
        (c: any) => c.data?.status === 'AVAILABLE',
      ) as { where: { id: { in: string[] } } };
      expect(release.where.id.in).toEqual(['t4', 't2']);
      expect(calls.deleteMany).toHaveLength(1);
      const archive = calls.update.find((c: any) => c.data?.isActive === false);
      expect(archive).toBeDefined();
      expect(view.isActive).toBe(false);
      expect(view.members.every((m) => m.status === 'AVAILABLE')).toBe(true);
    });
  });
});
