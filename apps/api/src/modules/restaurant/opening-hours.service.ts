import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { UpdateOpeningHoursDto } from './dto/opening-hours.dto';
import { BranchNotFoundError, InvalidOpeningHoursError } from './restaurant.errors';

/**
 * D90 — the branch's opening hours: the ordinary week, plus the dates that
 * do not follow it.
 *
 * Times are minutes since LOCAL midnight throughout. Nothing here converts to
 * or from UTC, deliberately: a restaurant that opens at seven opens at seven
 * on the wall clock, and a timestamp would carry an offset that moves under
 * it twice a year.
 */

export interface OpeningHoursDayView {
  dayOfWeek: number;
  isClosed: boolean;
  opensAt: number;
  closesAt: number;
}

export interface OpeningHoursOverrideView extends Omit<OpeningHoursDayView, 'dayOfWeek'> {
  date: string;
  note: string | null;
}

export interface OpeningHoursView {
  branchId: string;
  /** Only the weekdays the owner has configured. Absent = use `defaults`. */
  weekly: OpeningHoursDayView[];
  overrides: OpeningHoursOverrideView[];
  /**
   * What an unconfigured weekday resolves to. Sent rather than hard-coded in
   * the client so the fallback has exactly one definition; the numbers are
   * the window the calendar has always drawn.
   */
  defaults: { opensAt: number; closesAt: number };
}

/** 08:00–23:00 — the calendar's historic default window (D90). */
export const DEFAULT_OPENS_AT = 8 * 60;
export const DEFAULT_CLOSES_AT = 23 * 60;

/** `YYYY-MM-DD` → the UTC midnight Postgres stores for a `@db.Date`. */
export function dateOnly(value: string): Date {
  const [y = 1970, m = 1, d = 1] = value.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

/** The stored `@db.Date` back to `YYYY-MM-DD`, without a timezone in sight. */
export function toDateString(value: Date): string {
  return value.toISOString().slice(0, 10);
}

@Injectable()
export class OpeningHoursService {
  constructor(private readonly prisma: PrismaService) {}

  async get(tenantId: string, branchId: string): Promise<OpeningHoursView> {
    await this.assertBranch(tenantId, branchId);
    const [weekly, overrides] = await Promise.all([
      this.prisma.branchOpeningHours.findMany({
        where: { branchId },
        orderBy: { dayOfWeek: 'asc' },
      }),
      this.prisma.branchOpeningHoursOverride.findMany({
        where: { branchId },
        orderBy: { date: 'asc' },
      }),
    ]);
    return {
      branchId,
      weekly: weekly.map((r) => ({
        dayOfWeek: r.dayOfWeek,
        isClosed: r.isClosed,
        opensAt: r.opensAt,
        closesAt: r.closesAt,
      })),
      overrides: overrides.map((r) => ({
        date: toDateString(r.date),
        isClosed: r.isClosed,
        opensAt: r.opensAt,
        closesAt: r.closesAt,
        note: r.note,
      })),
      defaults: { opensAt: DEFAULT_OPENS_AT, closesAt: DEFAULT_CLOSES_AT },
    };
  }

  /**
   * Replace the whole schedule.
   *
   * Delete-then-insert inside one transaction rather than a diff: the owner
   * edits the week as a unit, and reconciling three lists (kept, added,
   * removed) is more code and more ways to leave a stale Monday behind.
   */
  async replace(
    tenantId: string,
    branchId: string,
    dto: UpdateOpeningHoursDto,
  ): Promise<OpeningHoursView> {
    await this.assertBranch(tenantId, branchId);
    this.validate(dto);

    await this.prisma.$transaction(async (tx) => {
      await tx.branchOpeningHours.deleteMany({ where: { branchId } });
      await tx.branchOpeningHoursOverride.deleteMany({ where: { branchId } });
      if (dto.weekly.length > 0) {
        await tx.branchOpeningHours.createMany({
          data: dto.weekly.map((d) => ({
            tenantId,
            branchId,
            dayOfWeek: d.dayOfWeek,
            isClosed: d.isClosed ?? false,
            opensAt: d.opensAt,
            closesAt: d.closesAt,
          })),
        });
      }
      if (dto.overrides.length > 0) {
        await tx.branchOpeningHoursOverride.createMany({
          data: dto.overrides.map((o) => ({
            tenantId,
            branchId,
            date: dateOnly(o.date),
            isClosed: o.isClosed ?? false,
            opensAt: o.opensAt,
            closesAt: o.closesAt,
            note: o.note?.trim() || null,
          })),
        });
      }
    });

    return this.get(tenantId, branchId);
  }

  /**
   * The rules class-validator cannot express: they need two fields at once,
   * or the whole list.
   *
   * A CLOSED day is exempt from the ordering rule — the times on a closed row
   * are the hours it keeps when it is open again, and refusing "closed, 09:00
   * to 09:00" would force an owner to invent a window for a day the door
   * never opens.
   */
  private validate(dto: UpdateOpeningHoursDto): void {
    const seenDays = new Set<number>();
    for (const d of dto.weekly) {
      if (seenDays.has(d.dayOfWeek)) {
        throw new InvalidOpeningHoursError(`Two sets of hours for the same weekday (${d.dayOfWeek})`);
      }
      seenDays.add(d.dayOfWeek);
      if (!d.isClosed && d.closesAt <= d.opensAt) {
        throw new InvalidOpeningHoursError(
          'Closing time must be after opening time. For a kitchen that shuts after midnight, count on past 24:00.',
        );
      }
    }
    const seenDates = new Set<string>();
    for (const o of dto.overrides) {
      if (seenDates.has(o.date)) {
        throw new InvalidOpeningHoursError(`Two sets of hours for ${o.date}`);
      }
      seenDates.add(o.date);
      if (!o.isClosed && o.closesAt <= o.opensAt) {
        throw new InvalidOpeningHoursError(
          `Closing time must be after opening time on ${o.date}.`,
        );
      }
    }
  }

  private async assertBranch(tenantId: string, branchId: string): Promise<void> {
    const branch = await this.prisma.branch.findFirst({
      where: { id: branchId, tenantId, isActive: true },
      select: { id: true },
    });
    // Foreign or deactivated branches answer 404, not 403 — no existence oracle.
    if (!branch) throw new BranchNotFoundError();
  }
}
