import type { OpeningHoursView } from './types';

/**
 * D90 — which hours apply on a given date.
 *
 * A pure resolver, in the shape D28/D31 asks for: the decision lives in one
 * place and the components read a result. Nothing here touches React, the
 * network or the clock, so the calendar and the settings preview cannot drift
 * apart on what "Monday" means.
 *
 * Times are MINUTES SINCE LOCAL MIDNIGHT. `closesAt` may exceed 1440 for a
 * kitchen that shuts in the small hours: 01:00 is 1500, and the extra 60
 * minutes are what tell the calendar to draw an hour past midnight.
 */

export interface ResolvedHours {
  isClosed: boolean;
  opensAt: number;
  closesAt: number;
  /** Which rule won — the settings screen says so out loud. */
  source: 'override' | 'weekly' | 'default';
  /** The owner's note on an override, when one won. */
  note: string | null;
}

/** The fallback used when the server has not stated one (an offline render). */
export const FALLBACK_HOURS = { opensAt: 8 * 60, closesAt: 23 * 60 };

/** Local `YYYY-MM-DD` for a Date — NOT `toISOString`, which is UTC. */
export function toDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate(),
  ).padStart(2, '0')}`;
}

/**
 * Override → weekday rule → default. First match wins.
 *
 * `hours` being null (still loading, or a failed request) resolves to the
 * default window rather than to "closed": an unresolved profile is not a
 * closed restaurant, and drawing an empty chart because a request was slow
 * would hide a day's bookings (D31 — unresolved is its own state).
 */
export function resolveHoursForDate(
  hours: OpeningHoursView | null,
  date: Date,
): ResolvedHours {
  const defaults = hours?.defaults ?? FALLBACK_HOURS;
  if (!hours) {
    return { isClosed: false, ...defaults, source: 'default', note: null };
  }

  const key = toDateKey(date);
  const override = hours.overrides.find((o) => o.date === key);
  if (override) {
    return {
      isClosed: override.isClosed,
      opensAt: override.opensAt,
      closesAt: override.closesAt,
      source: 'override',
      note: override.note,
    };
  }

  const weekly = hours.weekly.find((w) => w.dayOfWeek === date.getDay());
  if (weekly) {
    return {
      isClosed: weekly.isClosed,
      opensAt: weekly.opensAt,
      closesAt: weekly.closesAt,
      source: 'weekly',
      note: null,
    };
  }

  return { isClosed: false, ...defaults, source: 'default', note: null };
}

/** Minutes since midnight → `HH:MM`, counting past 24:00 back to 00:00. */
export function minutesToTimeInput(minutes: number): string {
  const wrapped = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(wrapped / 60)).padStart(2, '0')}:${String(wrapped % 60).padStart(2, '0')}`;
}

/** `HH:MM` → minutes since midnight. Returns null on anything unparseable. */
export function timeInputToMinutes(value: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/**
 * A human label: "09:00 – 22:00", or "09:00 – 01:00 (next day)".
 *
 * The next-day marker is not decoration. "18:00 – 01:00" read without it is a
 * seven-hour service or a seventeen-hour one depending on how you squint.
 */
export function formatHours(hours: Pick<ResolvedHours, 'isClosed' | 'opensAt' | 'closesAt'>): string {
  if (hours.isClosed) return 'Closed';
  const suffix = hours.closesAt >= 1440 ? ' (next day)' : '';
  return `${minutesToTimeInput(hours.opensAt)} – ${minutesToTimeInput(hours.closesAt)}${suffix}`;
}

export const WEEKDAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;
