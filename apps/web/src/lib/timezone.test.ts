import { describe, expect, it } from 'vitest';

import {
  addDays,
  availableTimeZones,
  daysInWindow,
  DEFAULT_TIME_ZONE,
  dayInTimeZone,
  formatDateInTimeZone,
  formatDateTimeInTimeZone,
  formatTimeInTimeZone,
  isValidTimeZone,
  parseDay,
  safeTimeZone,
  lastNDaysInTimeZone,
  startOfDayInTimeZone,
  timeZoneOffsetLabel,
  todayInTimeZone,
  zonedTimeToUtc,
} from '@hardware-pos/shared';

/**
 * `packages/shared` has no runner of its own, so its timezone maths is covered
 * here — apps/web is a real consumer and already runs vitest.
 *
 * The instant below is the one that motivates the whole feature: 20:30 UTC on
 * 31 July is already 1 August in Colombo. Which day a sale "happened on" depends
 * entirely on who is looking.
 */
const ACROSS_MIDNIGHT = new Date('2026-07-31T20:30:00Z');

describe('dayInTimeZone', () => {
  it('reports the local day, which can differ from the UTC day', () => {
    expect(dayInTimeZone(ACROSS_MIDNIGHT, 'Asia/Colombo')).toBe('2026-08-01');
    expect(dayInTimeZone(ACROSS_MIDNIGHT, 'UTC')).toBe('2026-07-31');
    expect(dayInTimeZone(ACROSS_MIDNIGHT, 'America/New_York')).toBe('2026-07-31');
  });

  it('handles a zone far west of UTC', () => {
    expect(dayInTimeZone(new Date('2026-08-01T05:00:00Z'), 'America/Los_Angeles')).toBe(
      '2026-07-31',
    );
  });
});

describe('zonedTimeToUtc', () => {
  it('resolves a wall-clock time in a zone to the right instant', () => {
    expect(zonedTimeToUtc(2026, 8, 1, 12, 0, 0, 'Asia/Colombo').toISOString()).toBe(
      '2026-08-01T06:30:00.000Z',
    );
  });

  it('round-trips: the instant reads back as the same day in that zone', () => {
    const utc = zonedTimeToUtc(2026, 8, 1, 0, 0, 0, 'America/Los_Angeles');
    expect(dayInTimeZone(utc, 'America/Los_Angeles')).toBe('2026-08-01');
  });

  it('uses the offset in force on the day, not a fixed one (DST)', () => {
    // US clocks spring forward on 2026-03-08, so noon is -5 before and -4 after.
    expect(zonedTimeToUtc(2026, 3, 7, 12, 0, 0, 'America/New_York').toISOString()).toBe(
      '2026-03-07T17:00:00.000Z',
    );
    expect(zonedTimeToUtc(2026, 3, 9, 12, 0, 0, 'America/New_York').toISOString()).toBe(
      '2026-03-09T16:00:00.000Z',
    );
  });

  it('keeps the intended day across an autumn transition', () => {
    const d = zonedTimeToUtc(2026, 11, 1, 12, 0, 0, 'America/New_York');
    expect(dayInTimeZone(d, 'America/New_York')).toBe('2026-11-01');
  });
});

describe('formatting', () => {
  it('renders the same instant as different days in different zones', () => {
    expect(formatDateInTimeZone(ACROSS_MIDNIGHT, 'Asia/Colombo')).toBe('01 Aug 2026');
    expect(formatDateInTimeZone(ACROSS_MIDNIGHT, 'America/New_York')).toBe('31 Jul 2026');
  });

  it('renders date and time together', () => {
    expect(formatDateTimeInTimeZone(ACROSS_MIDNIGHT, 'Asia/Colombo')).toBe('01 Aug 2026, 02:00');
  });

  it('renders time alone', () => {
    expect(formatTimeInTimeZone(ACROSS_MIDNIGHT, 'Asia/Colombo')).toBe('02:00');
  });

  it('falls back to the default zone rather than throwing on a bad one', () => {
    expect(formatDateInTimeZone(ACROSS_MIDNIGHT, 'Not/AZone')).toBe(
      formatDateInTimeZone(ACROSS_MIDNIGHT, DEFAULT_TIME_ZONE),
    );
  });
});

describe('zone validation', () => {
  it.each(['Asia/Colombo', 'UTC', 'America/New_York', 'Europe/London'])('accepts %s', (tz) => {
    expect(isValidTimeZone(tz)).toBe(true);
  });

  it.each(['', 'Not/AZone', 'nonsense'])('rejects %s', (tz) => {
    expect(isValidTimeZone(tz)).toBe(false);
  });

  it('safeTimeZone substitutes the default for anything unusable', () => {
    expect(safeTimeZone('Not/AZone')).toBe(DEFAULT_TIME_ZONE);
    expect(safeTimeZone(null)).toBe(DEFAULT_TIME_ZONE);
    expect(safeTimeZone('Europe/London')).toBe('Europe/London');
  });
});

describe('parseDay', () => {
  it('accepts a real calendar day', () => {
    expect(parseDay('2026-02-28')).toEqual({ year: 2026, month: 2, day: 28 });
  });

  it.each(['2026-02-30', '2026-13-01', '2026-00-10', '0099-01-01', '2026-8-1', 'nonsense', ''])(
    'rejects %s',
    (v) => {
      expect(parseDay(v)).toBeNull();
    },
  );
});

describe('todayInTimeZone', () => {
  it('is the injected instant read in the given zone', () => {
    expect(todayInTimeZone('Asia/Colombo', ACROSS_MIDNIGHT)).toBe('2026-08-01');
    expect(todayInTimeZone('UTC', ACROSS_MIDNIGHT)).toBe('2026-07-31');
  });
});

describe('calendar-day windows', () => {
  const COLOMBO = 'Asia/Colombo';

  it('starts a day at local midnight, not UTC midnight', () => {
    // Colombo is +5:30, so its midnight is 18:30 UTC the previous day. Cutting
    // the window at UTC midnight instead would run 05:30 to 05:30 local.
    expect(startOfDayInTimeZone('2026-08-01', COLOMBO).toISOString()).toBe(
      '2026-07-31T18:30:00.000Z',
    );
  });

  it('gives "today" as one full local day', () => {
    const now = new Date('2026-08-01T06:00:00Z'); // 11:30 in Colombo
    const { from, to } = lastNDaysInTimeZone(1, COLOMBO, now);
    expect(from.toISOString()).toBe('2026-07-31T18:30:00.000Z');
    expect(to.toISOString()).toBe('2026-08-01T18:30:00.000Z');
  });

  it('treats the small hours as still being the same local day', () => {
    // 20:00 UTC on 31 Jul is already 01:30 on 1 Aug in Colombo, so "today" is
    // the 1st — a server-clock window would still be reporting the 31st.
    const now = new Date('2026-07-31T20:00:00Z');
    const { from } = lastNDaysInTimeZone(1, COLOMBO, now);
    expect(dayInTimeZone(from, COLOMBO)).toBe('2026-08-01');
  });

  it('spans N whole local days ending with today', () => {
    const now = new Date('2026-08-10T06:00:00Z');
    const { from, to } = lastNDaysInTimeZone(7, COLOMBO, now);
    expect(dayInTimeZone(from, COLOMBO)).toBe('2026-08-04');
    expect(daysInWindow(from, to, COLOMBO)).toHaveLength(7);
  });

  it('enumerates each local day exactly once', () => {
    const { from, to } = lastNDaysInTimeZone(3, COLOMBO, new Date('2026-08-10T06:00:00Z'));
    expect(daysInWindow(from, to, COLOMBO)).toEqual(['2026-08-08', '2026-08-09', '2026-08-10']);
  });

  it('includes a partly-covered final day', () => {
    const from = startOfDayInTimeZone('2026-08-01', COLOMBO);
    const to = new Date(from.getTime() + 36 * 60 * 60 * 1000); // 1.5 days
    expect(daysInWindow(from, to, COLOMBO)).toEqual(['2026-08-01', '2026-08-02']);
  });

  it('counts whole days across a DST transition', () => {
    // 8 Mar 2026 is 23 hours long in New York; the window must still be 3 days.
    const now = new Date('2026-03-09T16:00:00Z');
    const { from, to } = lastNDaysInTimeZone(3, 'America/New_York', now);
    expect(daysInWindow(from, to, 'America/New_York')).toEqual([
      '2026-03-07',
      '2026-03-08',
      '2026-03-09',
    ]);
  });

  it('returns nothing for an inverted window', () => {
    const d = startOfDayInTimeZone('2026-08-01', COLOMBO);
    expect(daysInWindow(d, d, COLOMBO)).toEqual([]);
  });
});

describe('addDays', () => {
  it('crosses month and year boundaries', () => {
    expect(addDays('2026-08-31', 1)).toBe('2026-09-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
  });

  it('handles a leap day', () => {
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
  });
});

describe('availableTimeZones', () => {
  const zones = availableTimeZones();

  it('offers the whole IANA set, not a shortlist', () => {
    expect(zones.length).toBeGreaterThan(300);
  });

  it('includes UTC, which the supported-values list omits', () => {
    expect(zones).toContain('UTC');
  });

  it('includes the default and a spread of regions', () => {
    expect(zones).toContain(DEFAULT_TIME_ZONE);
    for (const region of ['Africa/', 'America/', 'Asia/', 'Europe/', 'Pacific/']) {
      expect(zones.some((z) => z.startsWith(region))).toBe(true);
    }
  });

  it('is sorted and free of duplicates', () => {
    expect([...zones].sort((a, b) => a.localeCompare(b))).toEqual(zones);
    expect(new Set(zones).size).toBe(zones.length);
  });

  it('offers only zones the formatters actually accept', () => {
    for (const tz of zones) expect(isValidTimeZone(tz)).toBe(true);
  });
});

describe('timeZoneOffsetLabel', () => {
  it('reports the offset in UTC±HH:MM form', () => {
    expect(timeZoneOffsetLabel('Asia/Colombo')).toBe('UTC+05:30');
    expect(timeZoneOffsetLabel('UTC')).toBe('UTC+00:00');
  });

  it('reflects the offset in force at the given instant (DST)', () => {
    const summer = new Date('2026-07-01T12:00:00Z');
    const winter = new Date('2026-01-01T12:00:00Z');
    expect(timeZoneOffsetLabel('Europe/London', summer)).toBe('UTC+01:00');
    expect(timeZoneOffsetLabel('Europe/London', winter)).toBe('UTC+00:00');
  });

  it('handles a negative and an extreme offset', () => {
    expect(timeZoneOffsetLabel('America/New_York', new Date('2026-01-01T12:00:00Z'))).toBe(
      'UTC-05:00',
    );
    expect(timeZoneOffsetLabel('Pacific/Kiritimati')).toBe('UTC+14:00');
  });

  it('degrades rather than throwing on an unknown zone', () => {
    expect(timeZoneOffsetLabel('Not/AZone')).toBe(timeZoneOffsetLabel(DEFAULT_TIME_ZONE));
  });
});
