import { BadRequestException } from '@nestjs/common';
import { dayInTimeZone } from '@hardware-pos/shared';

import { resolvePaymentDueDate, resolveSaleDate, toQuickBooksTxnDate } from './sale-date';

const COLOMBO = 'Asia/Colombo'; // +5:30, no DST
const NEW_YORK = 'America/New_York'; // -5/-4, DST

/** 15 Aug 2026, 14:23 UTC — mid-evening in Colombo, late morning in New York. */
const NOW = new Date('2026-08-15T14:23:00Z');

describe('resolveSaleDate', () => {
  it('falls back to the current instant when no date is given', () => {
    expect(resolveSaleDate(undefined, COLOMBO, NOW)).toEqual(NOW);
  });

  it('stores an instant that reads as the picked day in the shop zone', () => {
    const d = resolveSaleDate('2026-08-01', COLOMBO, NOW);
    expect(dayInTimeZone(d, COLOMBO)).toBe('2026-08-01');
  });

  it('anchors the day in the SHOP zone, not UTC', () => {
    // Midday Colombo on the 1st is 06:30Z that day. The instant is chosen so the
    // shop's calendar day is the one that survives.
    expect(resolveSaleDate('2026-08-01', COLOMBO, NOW).toISOString()).toBe(
      '2026-08-01T06:30:00.000Z',
    );
  });

  it('anchors a shop zone west of UTC the same way', () => {
    const d = resolveSaleDate('2026-08-01', NEW_YORK, NOW);
    expect(dayInTimeZone(d, NEW_YORK)).toBe('2026-08-01');
    expect(d.toISOString()).toBe('2026-08-01T16:00:00.000Z');
  });

  it('uses the offset in force on the picked day, across a DST boundary', () => {
    // US clocks spring forward on 8 Mar 2026: -5 before, -4 after.
    const before = resolveSaleDate('2026-03-07', NEW_YORK, NOW);
    const after = resolveSaleDate('2026-03-09', NEW_YORK, NOW);
    expect(before.toISOString()).toBe('2026-03-07T17:00:00.000Z');
    expect(after.toISOString()).toBe('2026-03-09T16:00:00.000Z');
    expect(dayInTimeZone(before, NEW_YORK)).toBe('2026-03-07');
    expect(dayInTimeZone(after, NEW_YORK)).toBe('2026-03-09');
  });

  it('accepts today as the shop reckons it', () => {
    expect(dayInTimeZone(resolveSaleDate('2026-08-15', COLOMBO, NOW), COLOMBO)).toBe('2026-08-15');
  });

  it('rejects tomorrow', () => {
    expect(() => resolveSaleDate('2026-08-16', COLOMBO, NOW)).toThrow(BadRequestException);
  });

  it('judges "today" by the shop clock, not UTC', () => {
    // 20:30 UTC on 31 Jul is already 1 Aug in Colombo, so the 1st is today there
    // and must be accepted — a UTC-based check would call it the future.
    const lateUtc = new Date('2026-07-31T20:30:00Z');
    expect(dayInTimeZone(lateUtc, 'UTC')).toBe('2026-07-31');
    expect(dayInTimeZone(lateUtc, COLOMBO)).toBe('2026-08-01');
    expect(() => resolveSaleDate('2026-08-01', COLOMBO, lateUtc)).not.toThrow();
  });

  it('still rejects a day that is tomorrow even in the shop zone', () => {
    const lateUtc = new Date('2026-07-31T20:30:00Z');
    expect(() => resolveSaleDate('2026-08-02', COLOMBO, lateUtc)).toThrow(BadRequestException);
  });

  it('accepts a date in a previous year', () => {
    expect(dayInTimeZone(resolveSaleDate('2025-12-31', COLOMBO, NOW), COLOMBO)).toBe('2025-12-31');
  });

  it.each(['not-a-date', '2026-8-1', '2026-02-30', '2026-13-01'])('rejects %s', (v) => {
    expect(() => resolveSaleDate(v, COLOMBO, NOW)).toThrow(BadRequestException);
  });

  it('treats an empty string as "no date given"', () => {
    // The DTO's @Matches already rejects '' at the boundary; the resolver stays
    // permissive so it cannot throw on a field that simply was not filled in.
    expect(resolveSaleDate('', COLOMBO, NOW)).toEqual(NOW);
  });

  it('rejects an absurdly early year from a half-typed date input', () => {
    expect(() => resolveSaleDate('0099-01-01', COLOMBO, NOW)).toThrow(BadRequestException);
    expect(() => resolveSaleDate('1899-01-01', COLOMBO, NOW)).toThrow(BadRequestException);
  });

  it('degrades to the default zone rather than throwing on an unknown one', () => {
    expect(() => resolveSaleDate('2026-08-01', 'Not/AZone', NOW)).not.toThrow();
  });
});

describe('toQuickBooksTxnDate', () => {
  it('reports the shop’s calendar day for the instant', () => {
    expect(toQuickBooksTxnDate(new Date('2026-08-01T06:30:00Z'), COLOMBO)).toBe('2026-08-01');
  });

  it('can differ from the UTC day for the same instant', () => {
    const instant = new Date('2026-07-31T20:30:00Z');
    expect(toQuickBooksTxnDate(instant, 'UTC')).toBe('2026-07-31');
    expect(toQuickBooksTxnDate(instant, COLOMBO)).toBe('2026-08-01');
  });

  it('round-trips a resolved sale date', () => {
    const d = resolveSaleDate('2026-03-07', NEW_YORK, NOW);
    expect(toQuickBooksTxnDate(d, NEW_YORK)).toBe('2026-03-07');
  });

  it('emits a bare calendar date with no time component', () => {
    expect(toQuickBooksTxnDate(NOW, COLOMBO)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('resolvePaymentDueDate', () => {
  const saleDate = resolveSaleDate('2026-08-01', COLOMBO, NOW);

  it('is not carried by a fully paid sale', () => {
    expect(
      resolvePaymentDueDate(undefined, { leavesBalance: false, saleDate, tz: COLOMBO }),
    ).toBeNull();
  });

  it('refuses a due date on a sale that owes nothing', () => {
    // Otherwise the sales list would show a due date against a settled sale.
    expect(() =>
      resolvePaymentDueDate('2026-09-01', { leavesBalance: false, saleDate, tz: COLOMBO }),
    ).toThrow(BadRequestException);
  });

  it('requires one when the sale leaves a balance', () => {
    expect(() =>
      resolvePaymentDueDate(undefined, { leavesBalance: true, saleDate, tz: COLOMBO }),
    ).toThrow(/required/i);
  });

  it('falls at the end of the day in the shop zone', () => {
    // 23:59:59 Colombo on 31 Aug is 18:29:59Z — money is due by the close of the
    // day, so a payment taken during it is not late.
    const due = resolvePaymentDueDate('2026-08-31', {
      leavesBalance: true,
      saleDate,
      tz: COLOMBO,
    });
    expect(due?.toISOString()).toBe('2026-08-31T18:29:59.000Z');
    expect(dayInTimeZone(due as Date, COLOMBO)).toBe('2026-08-31');
  });

  it('allows payment to fall due on the day of the sale', () => {
    const due = resolvePaymentDueDate('2026-08-01', {
      leavesBalance: true,
      saleDate,
      tz: COLOMBO,
    });
    expect(dayInTimeZone(due as Date, COLOMBO)).toBe('2026-08-01');
  });

  it('rejects a due date before the invoice date', () => {
    expect(() =>
      resolvePaymentDueDate('2026-07-31', { leavesBalance: true, saleDate, tz: COLOMBO }),
    ).toThrow(/earlier than the invoice date/i);
  });

  it('allows a backdated sale to be already overdue', () => {
    // A sale entered today but dated two months back can legitimately have a due
    // date that has already passed — it is overdue the moment it is recorded.
    const backdated = resolveSaleDate('2026-06-01', COLOMBO, NOW);
    const due = resolvePaymentDueDate('2026-07-01', {
      leavesBalance: true,
      saleDate: backdated,
      tz: COLOMBO,
    });
    expect(dayInTimeZone(due as Date, COLOMBO)).toBe('2026-07-01');
    expect((due as Date).getTime()).toBeLessThan(NOW.getTime());
  });

  it.each(['not-a-date', '2026-13-01', '2026-02-30'])('rejects %s', (v) => {
    expect(() =>
      resolvePaymentDueDate(v, { leavesBalance: true, saleDate, tz: COLOMBO }),
    ).toThrow(BadRequestException);
  });

  it('anchors to a western shop zone the same way', () => {
    const nySale = resolveSaleDate('2026-08-01', NEW_YORK, NOW);
    const due = resolvePaymentDueDate('2026-08-31', {
      leavesBalance: true,
      saleDate: nySale,
      tz: NEW_YORK,
    });
    expect(dayInTimeZone(due as Date, NEW_YORK)).toBe('2026-08-31');
  });
});
