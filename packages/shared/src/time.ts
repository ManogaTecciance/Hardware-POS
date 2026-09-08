/**
 * Timezone handling, shared by the browser and the API.
 *
 * The rule this package encodes:
 *
 *  - Every instant is STORED and TRANSPORTED in UTC. A `DateTime` column holds a
 *    UTC instant, and every datetime crosses the wire as an ISO-8601 string.
 *    Nothing is ever persisted as a bare calendar day.
 *  - Instants are converted to a timezone only at the moment they are SHOWN.
 *    Which timezone depends on what is being shown:
 *      · on screen  → the viewer's own zone, from `browserTimeZone()`
 *      · on a document (invoice, receipt, PDF report) → the shop's zone, from
 *        settings, so one invoice reads the same date for everyone who opens it
 *
 * Everything here is pure and dependency-free; the zone maths uses `Intl`, which
 * both Node (full ICU since v13) and every supported browser provide.
 */

/** Fallback when no shop timezone has been configured. */
export const DEFAULT_TIME_ZONE = 'Asia/Colombo';

/**
 * The viewer's own IANA zone (e.g. `Europe/London`). Browser-only — on the
 * server this reports the host's zone, which is not the viewer's, so never call
 * it during server rendering.
 */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || DEFAULT_TIME_ZONE;
  } catch {
    return DEFAULT_TIME_ZONE;
  }
}

/**
 * Every IANA zone this runtime knows, plus `UTC`.
 *
 * Read from ICU via `Intl.supportedValuesOf` rather than shipping a zone list:
 * a bundled list goes stale every time a country changes its rules, whereas this
 * one is exactly the set `Intl` will actually accept. `UTC` is added explicitly
 * because the canonical database spells it `Etc/UTC` and omits both from the
 * supported-values output.
 *
 * The fallback covers runtimes predating `supportedValuesOf` (Safari < 15.4) —
 * a short list is a degraded picker, not a broken one, and the API still accepts
 * any valid zone typed by other means.
 */
export function availableTimeZones(): string[] {
  const withUtc = (list: string[]) =>
    Array.from(new Set([...list, 'UTC'])).sort((a, b) => a.localeCompare(b));
  try {
    const supported = (
      Intl as unknown as { supportedValuesOf?: (k: string) => string[] }
    ).supportedValuesOf?.('timeZone');
    if (supported?.length) return withUtc(supported);
  } catch {
    /* fall through */
  }
  return withUtc([
    DEFAULT_TIME_ZONE,
    'Asia/Dubai',
    'Asia/Kolkata',
    'Asia/Singapore',
    'Europe/London',
  ]);
}

/**
 * `UTC+05:30` — the zone's current offset, for labelling a picker. The offset is
 * a property of the instant, not the zone, so a DST zone reads differently in
 * summer and winter; that is accurate rather than a defect.
 */
export function timeZoneOffsetLabel(tz: string, now: Date = new Date()): string {
  try {
    const part = new Intl.DateTimeFormat('en-GB', {
      timeZone: safeTimeZone(tz),
      timeZoneName: 'longOffset',
    })
      .formatToParts(now)
      .find((p) => p.type === 'timeZoneName')?.value;
    // ICU spells it GMT±HH:MM, and renders GMT alone at zero offset.
    if (!part) return 'UTC+00:00';
    return part === 'GMT' ? 'UTC+00:00' : part.replace('GMT', 'UTC');
  } catch {
    return 'UTC+00:00';
  }
}

/** True when `tz` is a zone this runtime actually knows. */
export function isValidTimeZone(tz: string): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** `tz` if usable, otherwise the default — so a bad setting degrades, never throws. */
export function safeTimeZone(tz: string | null | undefined): string {
  return tz && isValidTimeZone(tz) ? tz : DEFAULT_TIME_ZONE;
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** The wall-clock reading an observer in `tz` sees at instant `date`. */
function partsInTimeZone(date: Date, tz: string): ZonedParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    // `hourCycle: 'h23'` rather than `hour12: false`, which some ICU builds
    // render as 24:00 for midnight.
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);

  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    // Belt and braces against an ICU build that still reports 24 for midnight.
    hour: get('hour') % 24,
    minute: get('minute'),
    second: get('second'),
  };
}

/** `tz`'s offset from UTC at instant `date`, in milliseconds (east of UTC is positive). */
function offsetMs(date: Date, tz: string): number {
  const p = partsInTimeZone(date, tz);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  // Match the second, so the difference is purely the zone offset.
  return asIfUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/**
 * The UTC instant at which the clock in `tz` reads the given wall-clock time.
 *
 * Resolved in two passes: the first guess uses the offset in force at the naive
 * instant, the second re-checks it at the corrected instant. That second pass is
 * what makes the result right across a DST boundary, where the offset before and
 * after the transition differ.
 */
export function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  tz: string,
): Date {
  const zone = safeTimeZone(tz);
  const naive = Date.UTC(year, month - 1, day, hour, minute, second);
  const first = new Date(naive - offsetMs(new Date(naive), zone));
  const second2 = new Date(naive - offsetMs(first, zone));
  return second2;
}

/** The calendar day (`YYYY-MM-DD`) that instant `date` falls on in `tz`. */
export function dayInTimeZone(date: Date, tz: string): string {
  const p = partsInTimeZone(date, safeTimeZone(tz));
  return `${String(p.year).padStart(4, '0')}-${String(p.month).padStart(2, '0')}-${String(
    p.day,
  ).padStart(2, '0')}`;
}

/** Today's calendar day in `tz`. */
export function todayInTimeZone(tz: string, now: Date = new Date()): string {
  return dayInTimeZone(now, tz);
}

/** Parse `YYYY-MM-DD`, returning its numeric parts, or null when malformed. */
export function parseDay(ymd: string): { year: number; month: number; day: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  // Reject a day that does not exist (2026-02-30) rather than letting it roll.
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    return null;
  }
  return { year, month, day };
}

/** `YYYY-MM-DD` shifted by whole calendar days. Pure string/date arithmetic. */
export function addDays(ymd: string, days: number): string {
  const p = parseDay(ymd);
  if (!p) return ymd;
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day + days));
  return d.toISOString().slice(0, 10);
}

/**
 * The UTC instant at which `ymd` begins in `tz` — i.e. local midnight.
 *
 * This is the boundary business windows are cut on: "today's sales" runs from
 * one local midnight to the next, not from whatever midnight the server or the
 * database session happens to keep.
 */
export function startOfDayInTimeZone(ymd: string, tz: string): Date {
  const p = parseDay(ymd);
  if (!p) return new Date(NaN);
  return zonedTimeToUtc(p.year, p.month, p.day, 0, 0, 0, tz);
}

/**
 * The half-open window `[start, end)` covering `days` calendar days in `tz` and
 * ending at the close of today. `days = 1` is exactly today, midnight to midnight.
 */
export function lastNDaysInTimeZone(
  days: number,
  tz: string,
  now: Date = new Date(),
): { from: Date; to: Date } {
  const today = todayInTimeZone(tz, now);
  const span = Math.max(1, Math.floor(days));
  return {
    from: startOfDayInTimeZone(addDays(today, -(span - 1)), tz),
    to: startOfDayInTimeZone(addDays(today, 1), tz),
  };
}

/**
 * Every calendar day in `tz` touched by the half-open window `[from, to)`.
 * Used to zero-fill a series so a day with no sales still gets a slot — and so
 * the slots line up with the shop's days rather than 24-hour chunks.
 */
export function daysInWindow(from: Date, to: Date, tz: string, cap = 400): string[] {
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) return [];
  const first = dayInTimeZone(from, tz);
  // `to` is exclusive, so the last covered day is the one holding `to - 1ms`.
  const last = dayInTimeZone(new Date(to.getTime() - 1), tz);
  const out: string[] = [];
  let day = first;
  while (day <= last && out.length < cap) {
    out.push(day);
    day = addDays(day, 1);
  }
  return out;
}

const DATE_OPTS: Intl.DateTimeFormatOptions = {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
};

const TIME_OPTS: Intl.DateTimeFormatOptions = {
  hour: '2-digit',
  minute: '2-digit',
};

/** `01 Aug 2026` — the instant's calendar day as read in `tz`. */
export function formatDateInTimeZone(date: Date, tz: string, locale = 'en-GB'): string {
  return new Intl.DateTimeFormat(locale, { ...DATE_OPTS, timeZone: safeTimeZone(tz) }).format(date);
}

/** `01 Aug 2026, 14:23` — the instant as read in `tz`. */
export function formatDateTimeInTimeZone(date: Date, tz: string, locale = 'en-GB'): string {
  return new Intl.DateTimeFormat(locale, {
    ...DATE_OPTS,
    ...TIME_OPTS,
    timeZone: safeTimeZone(tz),
  }).format(date);
}

/** `14:23` — the instant's time of day as read in `tz`. */
export function formatTimeInTimeZone(date: Date, tz: string, locale = 'en-GB'): string {
  return new Intl.DateTimeFormat(locale, { ...TIME_OPTS, timeZone: safeTimeZone(tz) }).format(date);
}
