import { describe, expect, it } from 'vitest';

import {
  FALLBACK_HOURS,
  formatHours,
  minutesToTimeInput,
  resolveHoursForDate,
  timeInputToMinutes,
  toDateKey,
} from './opening-hours';
import type { OpeningHoursView } from './types';

/**
 * D90 — the resolver decides which rule applies, so this is where the
 * precedence is proven. Every "wins" assertion is paired with the rule it
 * beat still being present in the input: a resolver that ignored weekday
 * rules entirely would satisfy "the override wins" while being broken.
 */

const MONDAY = new Date(2026, 7, 10); // 2026-08-10 is a Monday
const THURSDAY = new Date(2026, 7, 13); // the poya day in the PO's example

function view(over: Partial<OpeningHoursView> = {}): OpeningHoursView {
  return {
    branchId: 'br_1',
    weekly: [],
    overrides: [],
    defaults: { opensAt: 480, closesAt: 1380 },
    ...over,
  };
}

describe('resolveHoursForDate', () => {
  it('falls back to the server-stated default when nothing is configured', () => {
    const r = resolveHoursForDate(view(), MONDAY);
    expect(r).toEqual({ isClosed: false, opensAt: 480, closesAt: 1380, source: 'default', note: null });
  });

  it('an unresolved schedule is the default window, NOT a closed restaurant', () => {
    // D31 — a slow or failed request must not hide a day's bookings.
    const r = resolveHoursForDate(null, MONDAY);
    expect(r.isClosed).toBe(false);
    expect(r.opensAt).toBe(FALLBACK_HOURS.opensAt);
    expect(r.closesAt).toBe(FALLBACK_HOURS.closesAt);
    expect(r.source).toBe('default');
  });

  it('a weekday rule beats the default, and only on its own weekday', () => {
    const hours = view({ weekly: [{ dayOfWeek: 1, isClosed: false, opensAt: 540, closesAt: 1320 }] });

    const monday = resolveHoursForDate(hours, MONDAY);
    expect(monday).toEqual({ isClosed: false, opensAt: 540, closesAt: 1320, source: 'weekly', note: null });

    // NEGATIVE: Thursday is not Monday and must fall through to the default.
    const thursday = resolveHoursForDate(hours, THURSDAY);
    expect(thursday.source).toBe('default');
    expect(thursday.opensAt).toBe(480);
  });

  it('a date override beats the weekday rule that would otherwise apply', () => {
    const hours = view({
      // The rule it must beat is present, and it is the rule for THURSDAY —
      // otherwise "the override won" proves nothing.
      weekly: [{ dayOfWeek: 4, isClosed: false, opensAt: 420, closesAt: 1380 }],
      overrides: [
        { date: '2026-08-13', isClosed: true, opensAt: 480, closesAt: 1380, note: 'Poya day' },
      ],
    });

    expect(resolveHoursForDate(hours, THURSDAY)).toEqual({
      isClosed: true,
      opensAt: 480,
      closesAt: 1380,
      source: 'override',
      note: 'Poya day',
    });

    // POSITIVE CONTROL: the weekday rule still applies to the NEXT Thursday,
    // so the override is scoped to its date rather than disabling the rule.
    const nextThursday = new Date(2026, 7, 20);
    expect(nextThursday.getDay()).toBe(4);
    expect(resolveHoursForDate(hours, nextThursday)).toMatchObject({
      source: 'weekly',
      opensAt: 420,
      isClosed: false,
    });
  });

  it('the PO example resolves as stated: 07:00–23:00 every day, 09:00–22:00 on Mondays', () => {
    const hours = view({
      weekly: [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({
        dayOfWeek,
        isClosed: false,
        opensAt: dayOfWeek === 1 ? 540 : 420,
        closesAt: dayOfWeek === 1 ? 1320 : 1380,
      })),
    });

    expect(formatHours(resolveHoursForDate(hours, MONDAY))).toBe('09:00 – 22:00');
    expect(formatHours(resolveHoursForDate(hours, THURSDAY))).toBe('07:00 – 23:00');
  });
});

describe('time conversion', () => {
  it('round-trips a wall-clock time', () => {
    for (const t of ['00:00', '07:00', '09:30', '23:59']) {
      expect(minutesToTimeInput(timeInputToMinutes(t)!)).toBe(t);
    }
  });

  it('renders a past-midnight closing time on the clock it would show', () => {
    expect(minutesToTimeInput(1500)).toBe('01:00');
    // …and says so, because "18:00 – 01:00" is otherwise ambiguous.
    expect(formatHours({ isClosed: false, opensAt: 1080, closesAt: 1500 })).toBe(
      '18:00 – 01:00 (next day)',
    );
    // NEGATIVE: a same-day close carries no marker.
    expect(formatHours({ isClosed: false, opensAt: 1080, closesAt: 1380 })).toBe('18:00 – 23:00');
  });

  it('refuses input that is not a time', () => {
    for (const bad of ['', 'noon', '25:00', '12:60', '12', '1200']) {
      expect(timeInputToMinutes(bad)).toBeNull();
    }
    // POSITIVE control so the negatives above are not passing on a parser
    // that rejects everything.
    expect(timeInputToMinutes('9:05')).toBe(545);
  });

  it('a closed day formats as Closed regardless of the times it carries', () => {
    expect(formatHours({ isClosed: true, opensAt: 540, closesAt: 1320 })).toBe('Closed');
  });
});

describe('toDateKey', () => {
  it('uses the LOCAL date, not the UTC one', () => {
    // 23:30 local on the 13th is the 14th in UTC anywhere east of Greenwich.
    // toISOString().slice(0,10) is the bug this helper exists to avoid.
    const late = new Date(2026, 7, 13, 23, 30);
    expect(toDateKey(late)).toBe('2026-08-13');
    expect(toDateKey(new Date(2026, 0, 1))).toBe('2026-01-01');
  });
});
