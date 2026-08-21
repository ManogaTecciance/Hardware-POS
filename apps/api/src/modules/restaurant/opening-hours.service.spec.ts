import { PrismaService } from '../../prisma/prisma.service';
import { UpdateOpeningHoursDto } from './dto/opening-hours.dto';
import {
  DEFAULT_CLOSES_AT,
  DEFAULT_OPENS_AT,
  OpeningHoursService,
  dateOnly,
  toDateString,
} from './opening-hours.service';
import { BranchNotFoundError, InvalidOpeningHoursError } from './restaurant.errors';

/**
 * D90 — the rules that keep a schedule drawable.
 *
 * Every refusal below is paired with the neighbouring case that must still be
 * ACCEPTED, because a validator that rejects everything passes a suite of
 * negatives while making the feature unusable.
 */

function buildService(rows: { weekly?: any[]; overrides?: any[] } = {}) {
  const weeklyRows = rows.weekly ?? [];
  const overrideRows = rows.overrides ?? [];
  const tx = {
    branchOpeningHours: { deleteMany: jest.fn(async () => ({})), createMany: jest.fn(async () => ({})) },
    branchOpeningHoursOverride: {
      deleteMany: jest.fn(async () => ({})),
      createMany: jest.fn(async () => ({})),
    },
  };
  const prisma = {
    branch: { findFirst: jest.fn(async () => ({ id: 'br_1' })) },
    branchOpeningHours: { findMany: jest.fn(async () => weeklyRows) },
    branchOpeningHoursOverride: { findMany: jest.fn(async () => overrideRows) },
    $transaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  return {
    service: new OpeningHoursService(prisma as unknown as PrismaService),
    prisma,
    tx,
  };
}

const week = (over: Partial<UpdateOpeningHoursDto> = {}): UpdateOpeningHoursDto => ({
  weekly: [{ dayOfWeek: 1, isClosed: false, opensAt: 540, closesAt: 1320 }],
  overrides: [],
  ...over,
});

describe('D90 — reading the schedule', () => {
  it('an unconfigured branch reports no rules and the documented fallback', async () => {
    const { service } = buildService();

    const view = await service.get('tnt', 'br_1');

    expect(view.weekly).toEqual([]);
    expect(view.overrides).toEqual([]);
    // POSITIVE: the fallback is sent, not left for the client to invent.
    expect(view.defaults).toEqual({ opensAt: DEFAULT_OPENS_AT, closesAt: DEFAULT_CLOSES_AT });
    expect(view.defaults).toEqual({ opensAt: 480, closesAt: 1380 }); // 08:00–23:00
  });

  it('returns the stored rules with dates as YYYY-MM-DD, not timestamps', async () => {
    const { service } = buildService({
      weekly: [{ dayOfWeek: 1, isClosed: false, opensAt: 540, closesAt: 1320 }],
      overrides: [
        {
          date: new Date(Date.UTC(2026, 7, 13)),
          isClosed: true,
          opensAt: 480,
          closesAt: 1380,
          note: 'Poya day',
        },
      ],
    });

    const view = await service.get('tnt', 'br_1');

    expect(view.weekly).toEqual([{ dayOfWeek: 1, isClosed: false, opensAt: 540, closesAt: 1320 }]);
    expect(view.overrides).toEqual([
      { date: '2026-08-13', isClosed: true, opensAt: 480, closesAt: 1380, note: 'Poya day' },
    ]);
    // NEGATIVE: no timezone leaks into the wire format.
    expect(JSON.stringify(view.overrides)).not.toContain('T00:00');
  });

  it('a foreign or deactivated branch answers 404, not 403', async () => {
    const { service, prisma } = buildService();
    prisma.branch.findFirst.mockResolvedValueOnce(null as never);

    await expect(service.get('tnt', 'br_other')).rejects.toBeInstanceOf(BranchNotFoundError);
  });
});

describe('D90 — replacing the schedule', () => {
  it('clears both tables and writes the new rules in one transaction', async () => {
    const { service, tx, prisma } = buildService();

    await service.replace('tnt', 'br_1', week({
      overrides: [{ date: '2026-08-13', isClosed: true, opensAt: 480, closesAt: 1380 }],
    }));

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.branchOpeningHours.deleteMany).toHaveBeenCalledWith({ where: { branchId: 'br_1' } });
    expect(tx.branchOpeningHoursOverride.deleteMany).toHaveBeenCalledWith({
      where: { branchId: 'br_1' },
    });
    expect(tx.branchOpeningHours.createMany).toHaveBeenCalledWith({
      data: [{ tenantId: 'tnt', branchId: 'br_1', dayOfWeek: 1, isClosed: false, opensAt: 540, closesAt: 1320 }],
    });
    expect(tx.branchOpeningHoursOverride.createMany).toHaveBeenCalledWith({
      data: [
        {
          tenantId: 'tnt',
          branchId: 'br_1',
          date: dateOnly('2026-08-13'),
          isClosed: true,
          opensAt: 480,
          closesAt: 1380,
          note: null,
        },
      ],
    });
  });

  it('an empty schedule clears the rules without writing an empty createMany', async () => {
    const { service, tx } = buildService();

    await service.replace('tnt', 'br_1', { weekly: [], overrides: [] });

    expect(tx.branchOpeningHours.deleteMany).toHaveBeenCalled();
    expect(tx.branchOpeningHours.createMany).not.toHaveBeenCalled();
    expect(tx.branchOpeningHoursOverride.createMany).not.toHaveBeenCalled();
  });

  it('refuses a closing time at or before its opening time — and accepts one after', async () => {
    const { service } = buildService();

    await expect(
      service.replace('tnt', 'br_1', week({ weekly: [{ dayOfWeek: 1, opensAt: 600, closesAt: 600 }] })),
    ).rejects.toBeInstanceOf(InvalidOpeningHoursError);
    await expect(
      service.replace('tnt', 'br_1', week({ weekly: [{ dayOfWeek: 1, opensAt: 600, closesAt: 540 }] })),
    ).rejects.toBeInstanceOf(InvalidOpeningHoursError);

    // POSITIVE, same shape: one minute later is fine, and so is past midnight.
    await expect(
      service.replace('tnt', 'br_1', week({ weekly: [{ dayOfWeek: 1, opensAt: 600, closesAt: 601 }] })),
    ).resolves.toBeDefined();
    await expect(
      service.replace('tnt', 'br_1', week({ weekly: [{ dayOfWeek: 1, opensAt: 1080, closesAt: 1500 }] })),
    ).resolves.toBeDefined();
  });

  it('a closed day is exempt from the ordering rule', async () => {
    const { service } = buildService();

    // The times on a closed row are the hours it keeps when it opens again;
    // forcing a window on a day the door never opens is noise.
    await expect(
      service.replace('tnt', 'br_1', week({
        weekly: [{ dayOfWeek: 1, isClosed: true, opensAt: 540, closesAt: 540 }],
      })),
    ).resolves.toBeDefined();
  });

  it('refuses two rules for the same weekday, and two for the same date', async () => {
    const { service } = buildService();

    await expect(
      service.replace('tnt', 'br_1', week({
        weekly: [
          { dayOfWeek: 1, opensAt: 540, closesAt: 1320 },
          { dayOfWeek: 1, opensAt: 600, closesAt: 1200 },
        ],
      })),
    ).rejects.toBeInstanceOf(InvalidOpeningHoursError);

    await expect(
      service.replace('tnt', 'br_1', week({
        overrides: [
          { date: '2026-08-13', opensAt: 540, closesAt: 1320 },
          { date: '2026-08-13', opensAt: 600, closesAt: 1200 },
        ],
      })),
    ).rejects.toBeInstanceOf(InvalidOpeningHoursError);

    // POSITIVE: seven different weekdays and two different dates are fine.
    await expect(
      service.replace('tnt', 'br_1', {
        weekly: [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({ dayOfWeek, opensAt: 420, closesAt: 1380 })),
        overrides: [
          { date: '2026-08-13', opensAt: 540, closesAt: 1320 },
          { date: '2026-08-14', opensAt: 540, closesAt: 1320 },
        ],
      }),
    ).resolves.toBeDefined();
  });

  it('writes nothing at all when validation fails', async () => {
    const { service, tx, prisma } = buildService();

    await expect(
      service.replace('tnt', 'br_1', week({ weekly: [{ dayOfWeek: 1, opensAt: 600, closesAt: 300 }] })),
    ).rejects.toBeInstanceOf(InvalidOpeningHoursError);

    // The refusal happens BEFORE the transaction opens — a half-applied
    // schedule would leave the branch with yesterday's Monday deleted and
    // nothing to replace it.
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.branchOpeningHours.deleteMany).not.toHaveBeenCalled();
  });

  it('trims a blank note down to null rather than storing whitespace', async () => {
    const { service, tx } = buildService();

    await service.replace('tnt', 'br_1', {
      weekly: [],
      overrides: [{ date: '2026-08-13', opensAt: 540, closesAt: 1320, note: '   ' }],
    });

    expect(tx.branchOpeningHoursOverride.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ note: null })],
    });
  });
});

describe('D90 — date conversion round-trips', () => {
  it('a date survives the trip to the database and back', () => {
    expect(toDateString(dateOnly('2026-08-13'))).toBe('2026-08-13');
    // NEGATIVE: the naive `new Date('2026-08-13')` in a negative-offset zone
    // lands on the 12th. UTC construction is what stops that.
    expect(dateOnly('2026-08-13').getUTCDate()).toBe(13);
    expect(dateOnly('2026-01-01').getUTCMonth()).toBe(0);
  });
});
