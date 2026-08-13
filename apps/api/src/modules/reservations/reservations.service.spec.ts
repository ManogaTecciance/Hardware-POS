import { ReservationsService } from './reservations.service';
import {
  InvalidListWindowError,
  ReservationInPastError,
  ReservationNotFoundError,
  ReservationOverlapError,
  ReservationStatusConflictError,
  TableNotFoundError,
} from './reservations.errors';

/**
 * The service under a stubbed Prisma. `$transaction` runs the callback with
 * the same stub, so the lock → overlap-check → write sequence executes for
 * real; `$queryRaw` serves both the FOR UPDATE lock (result ignored) and the
 * DocumentSequence upsert (reads rows[0].value).
 */
function build(overrides: {
  branch?: unknown;
  table?: unknown;
  clash?: unknown;
  reservation?: unknown;
} = {}) {
  const calls: Record<string, unknown[]> = { create: [], update: [], raw: [] };
  const prisma: any = {
    $transaction: (fn: (tx: unknown) => unknown) => fn(prisma),
    $queryRaw: jest.fn(async (...args: unknown[]) => {
      calls.raw.push(args);
      return [{ value: 7 }];
    }),
    branch: { findFirst: jest.fn(async () => overrides.branch ?? { id: 'brn_1' }) },
    restaurantTable: {
      findFirst: jest.fn(async () => ('table' in overrides ? overrides.table : { id: 'tbl_1' })),
    },
    tableReservation: {
      findMany: jest.fn(async () => []),
      findFirst: jest.fn(),
      create: jest.fn(async (args: { data: Record<string, unknown> }) => {
        calls.create.push(args);
        return { ...baseRow(), ...args.data, id: 'rsv_new' };
      }),
      update: jest.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        calls.update.push(args);
        return { ...baseRow(), ...args.data, id: args.where.id };
      }),
    },
  };
  // The by-id load (update/setStatus) queries `where.id` as a string; the
  // overlap probe either omits `id` or negates it (`{ not: … }`). Routing on
  // the VALUE shape, not key presence, keeps the two distinguishable.
  prisma.tableReservation.findFirst.mockImplementation(async (args: { where: Record<string, unknown> }) =>
    typeof args.where.id === 'string' ? (overrides.reservation ?? null) : (overrides.clash ?? null),
  );
  return { service: new ReservationsService(prisma), prisma, calls };
}

function baseRow() {
  return {
    id: 'rsv_1',
    tenantId: 'tnt_1',
    branchId: 'brn_1',
    tableId: 'tbl_1',
    reservationNumber: 'RSV-000007',
    customerId: null,
    customerName: 'Nimal Perera',
    customerPhone: '0771234567',
    partySize: 4,
    startAt: hoursFromNow(24),
    endAt: hoursFromNow(25.5),
    status: 'BOOKED' as const,
    notes: null,
    createdByUserId: 'usr_1',
    createdAt: new Date(),
  };
}

function hoursFromNow(h: number): Date {
  return new Date(Date.now() + h * 3_600_000);
}

const TENANT = 'tnt_1';
const BRANCH = 'brn_1';
const ACTOR = 'usr_1';

function createDto(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    tableId: 'tbl_1',
    customerName: 'Nimal Perera',
    customerPhone: '0771234567',
    partySize: 4,
    startAt: hoursFromNow(24).toISOString(),
    durationMinutes: 90,
    ...overrides,
  } as never;
}

describe('ReservationsService', () => {
  describe('create', () => {
    it('books a free slot: locks the table, numbers via DocumentSequence, snapshots contact', async () => {
      const { service, calls } = build();
      const view = await service.create(TENANT, BRANCH, ACTOR, createDto());

      expect(view.reservationNumber).toBe('RSV-000007');
      expect(view.customerName).toBe('Nimal Perera');
      // The FOR UPDATE lock ran before the insert.
      const rawSql = (calls.raw as unknown[][]).map((a) => JSON.stringify(a[0]));
      expect(rawSql.some((q) => q.includes('FOR UPDATE'))).toBe(true);
      // endAt derives from startAt + duration — the pair can never disagree.
      const created = (calls.create[0] as { data: { startAt: Date; endAt: Date; createdByUserId: string } }).data;
      expect(created.endAt.getTime() - created.startAt.getTime()).toBe(90 * 60_000);
      // Attribution comes from the actor, never the DTO.
      expect(created.createdByUserId).toBe(ACTOR);
    });

    it('rejects an overlapping ACTIVE reservation with 409 naming the blocker', async () => {
      const { service } = build({ clash: { reservationNumber: 'RSV-000003' } });
      await expect(service.create(TENANT, BRANCH, ACTOR, createDto())).rejects.toThrow(
        ReservationOverlapError,
      );
    });

    it('rejects a start in the past beyond the walk-up grace', async () => {
      const { service } = build();
      await expect(
        service.create(TENANT, BRANCH, ACTOR, createDto({ startAt: hoursFromNow(-2).toISOString() })),
      ).rejects.toThrow(ReservationInPastError);
    });

    it('allows a start a few minutes ago (recording a walk-up is not booking the past)', async () => {
      const { service } = build();
      const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString();
      await expect(service.create(TENANT, BRANCH, ACTOR, createDto({ startAt: fiveMinAgo }))).resolves.toMatchObject({
        reservationNumber: 'RSV-000007',
      });
    });

    it('404s an archived or foreign table AFTER taking the lock', async () => {
      const { service } = build({ table: null });
      await expect(service.create(TENANT, BRANCH, ACTOR, createDto())).rejects.toThrow(TableNotFoundError);
    });
  });

  describe('list', () => {
    it('rejects an inverted or unparsable window', async () => {
      const { service } = build();
      await expect(service.list(TENANT, BRANCH, hoursFromNow(2), hoursFromNow(1))).rejects.toThrow(
        InvalidListWindowError,
      );
      await expect(
        service.list(TENANT, BRANCH, new Date('nonsense'), hoursFromNow(1)),
      ).rejects.toThrow(InvalidListWindowError);
    });

    it('queries by interval intersection, hiding cancelled/no-show by default', async () => {
      const { service, prisma } = build();
      const from = hoursFromNow(0);
      const to = hoursFromNow(24);
      await service.list(TENANT, BRANCH, from, to);
      const where = prisma.tableReservation.findMany.mock.calls[0][0].where;
      // Intersection, not containment: a booking straddling midnight shows on
      // both days.
      expect(where.startAt).toEqual({ lt: to });
      expect(where.endAt).toEqual({ gt: from });
      expect(where.status).toEqual({ in: ['BOOKED', 'SEATED', 'COMPLETED'] });

      await service.list(TENANT, BRANCH, from, to, true);
      const whereAll = prisma.tableReservation.findMany.mock.calls[1][0].where;
      expect(whereAll.status).toBeUndefined();
    });
  });

  describe('update', () => {
    it('404s a reservation outside the tenant', async () => {
      const { service } = build({ reservation: null });
      await expect(service.update(TENANT, 'rsv_x', { notes: 'window seat' } as never)).rejects.toThrow(
        ReservationNotFoundError,
      );
    });

    it('refuses to edit a closed reservation', async () => {
      const { service } = build({ reservation: { ...baseRow(), status: 'COMPLETED' } });
      await expect(service.update(TENANT, 'rsv_1', { notes: 'x' } as never)).rejects.toThrow(
        ReservationStatusConflictError,
      );
    });

    it('re-checks overlap when the slot moves, excluding itself', async () => {
      const row = baseRow();
      const { service, prisma } = build({ reservation: row });
      await service.update(TENANT, 'rsv_1', { startAt: hoursFromNow(30).toISOString() } as never);
      const overlapCall = prisma.tableReservation.findFirst.mock.calls.find(
        (c: [{ where: Record<string, unknown> }]) => !('id' in c[0].where) || typeof c[0].where.id === 'object',
      );
      expect(overlapCall).toBeDefined();
      expect(overlapCall[0].where.id).toEqual({ not: 'rsv_1' });
    });

    it('does NOT run the overlap check for a notes-only edit', async () => {
      const row = baseRow();
      const { service, calls } = build({ reservation: row });
      await service.update(TENANT, 'rsv_1', { notes: 'birthday' } as never);
      const rawSql = (calls.raw as unknown[][]).map((a) => JSON.stringify(a[0]));
      expect(rawSql.some((q) => q.includes('FOR UPDATE'))).toBe(false);
    });

    it('keeps the existing duration when only startAt moves', async () => {
      const row = baseRow(); // 90 minutes long
      const { service, calls } = build({ reservation: row });
      const newStart = hoursFromNow(48);
      await service.update(TENANT, 'rsv_1', { startAt: newStart.toISOString() } as never);
      const updated = (calls.update[0] as { data: { startAt: Date; endAt: Date } }).data;
      expect(updated.endAt.getTime() - updated.startAt.getTime()).toBe(90 * 60_000);
    });
  });

  describe('setStatus', () => {
    it.each([
      ['BOOKED', 'SEATED'],
      ['BOOKED', 'CANCELLED'],
      ['BOOKED', 'NO_SHOW'],
      ['SEATED', 'COMPLETED'],
    ] as const)('allows %s → %s', async (from, to) => {
      const { service } = build({ reservation: { ...baseRow(), status: from } });
      await expect(service.setStatus(TENANT, 'rsv_1', to)).resolves.toMatchObject({ status: to });
    });

    it.each([
      ['COMPLETED', 'SEATED'],
      ['CANCELLED', 'BOOKED'],
      ['NO_SHOW', 'BOOKED'],
      ['BOOKED', 'COMPLETED'],
      ['SEATED', 'NO_SHOW'],
    ] as const)('refuses %s → %s', async (from, to) => {
      const { service } = build({ reservation: { ...baseRow(), status: from } });
      await expect(service.setStatus(TENANT, 'rsv_1', to)).rejects.toThrow(ReservationStatusConflictError);
    });

    it('un-seat (SEATED → BOOKED) re-validates the slot is still free', async () => {
      const { service, calls } = build({ reservation: { ...baseRow(), status: 'SEATED' } });
      await service.setStatus(TENANT, 'rsv_1', 'BOOKED');
      const rawSql = (calls.raw as unknown[][]).map((a) => JSON.stringify(a[0]));
      expect(rawSql.some((q) => q.includes('FOR UPDATE'))).toBe(true);
    });
  });
});
