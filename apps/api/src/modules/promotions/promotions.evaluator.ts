/**
 * D45 — Pure, injection-free promotion scheduler.
 *
 * Given a `Promotion` row and a context (now / branchId / channel), decide
 * whether the promotion is currently valid. The evaluator carries no I/O and
 * no persistence — it is called by the service (for `onlyCurrentlyValid`
 * filtering) and by the POS Catalogue read path (for badging). Keeping it a
 * function rather than an `@Injectable` makes the promotion tests exhaustive
 * without a Nest container.
 *
 * Timezone note: `startTime` / `endTime` are wall-clock strings in the
 * tenant's local zone (see `Promotion` doc-comments). The evaluator honours
 * `tenantTimeZone` when present via a UTC → local component read; when absent
 * it falls back to the host's local zone, which matches how legacy `MenuItem`
 * availability windows are evaluated on the same server.
 *
 * ## `startsOn` / `endsOn` are CALENDAR DAYS, not instants (D139)
 *
 * The editor sends `type="date"`, so `'2026-09-30'` reaches the service and
 * `new Date()` parses it as midnight UTC. Compared as an instant — which is
 * what this did — "ends 30 Sep" expired at 00:00 UTC ON the 30th: the whole
 * final day was lost, and for a tenant ahead of UTC the promotion died
 * mid-morning of the day it was supposed to run.
 *
 * An operator setting an end date means a whole day, inclusive, in their own
 * zone. So both bounds are compared as `YYYY-MM-DD` calendar dates: the
 * stored value's UTC date (which IS the date that was typed, because a bare
 * date parses as UTC midnight) against today's date in the tenant's zone.
 * Lexicographic order on that format is chronological order, so the
 * comparison needs no date arithmetic and no second parse.
 */

export interface PromotionScheduleShape {
  isActive: boolean;
  startsOn: Date | null;
  endsOn: Date | null;
  daysOfWeek: string[];
  startTime: string | null;
  endTime: string | null;
  branchScope: string[];
  channelScope: string[];
}

export interface EvaluationContext {
  now: Date;
  branchId?: string;
  channel?: string;
  tenantTimeZone?: string;
}

/**
 * The vocabulary the schedule columns speak. Declared here (not imported
 * from Prisma) so the evaluator has no runtime dependency on the client.
 */
const DAY_INDEX_TO_KEY = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'] as const;

export function isPromotionActive(
  promotion: PromotionScheduleShape,
  context: EvaluationContext,
): boolean {
  // Short-circuit first: an inactive row is never valid whatever the schedule
  // says. Keeps the paired negative test cheap and unambiguous.
  if (!promotion.isActive) return false;

  const { now } = context;

  // Wall-clock components read in the tenant zone if supplied. Falling back
  // to host-local (Intl with the runtime default) is the same behaviour the
  // MenuAvailability check uses today.
  const local = resolveLocalClock(now, context.tenantTimeZone);

  // Both bounds are inclusive whole days in the tenant's zone — see the
  // module comment for why an instant comparison lost the final day.
  if (promotion.startsOn && local.date < calendarDateOf(promotion.startsOn)) return false;
  if (promotion.endsOn && local.date > calendarDateOf(promotion.endsOn)) return false;

  if (promotion.daysOfWeek.length > 0) {
    const todayKey = DAY_INDEX_TO_KEY[local.weekday];
    if (!promotion.daysOfWeek.includes(todayKey)) return false;
  }

  if (promotion.startTime || promotion.endTime) {
    // Half-open interval [start, end). A single-endpoint set (only start, only
    // end) is treated as either "from that time forward" or "until that time"
    // — schema validation refuses this shape at write time, but we defend
    // against a hand-edited row rather than crashing the read path.
    const minutesNow = local.hours * 60 + local.minutes;
    const start = promotion.startTime ? toMinutes(promotion.startTime) : 0;
    const end = promotion.endTime ? toMinutes(promotion.endTime) : 24 * 60;
    if (minutesNow < start || minutesNow >= end) return false;
  }

  // Non-empty scope + missing context = does not apply. "No branch given" is
  // NOT the same as "every branch" — an unscoped catalogue read that forgot
  // to pass the branch would otherwise silently claim every promotion is on
  // regardless of where the caller was standing.
  if (promotion.branchScope.length > 0) {
    if (!context.branchId) return false;
    if (!promotion.branchScope.includes(context.branchId)) return false;
  }

  if (promotion.channelScope.length > 0) {
    if (!context.channel) return false;
    if (!promotion.channelScope.includes(context.channel)) return false;
  }

  return true;
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map((v) => Number(v));
  return h * 60 + m;
}

/**
 * The calendar date a stored `startsOn` / `endsOn` names, as `YYYY-MM-DD`.
 *
 * Read in UTC on purpose. The column is written from the editor's bare
 * `type="date"` value, which `new Date()` parses as UTC midnight — so the UTC
 * date IS the date the operator typed. Reading it host-local would shift it a
 * day for any server west of Greenwich.
 */
function calendarDateOf(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/** Two digits, for assembling a `YYYY-MM-DD` from clock components. */
const pad2 = (n: number): string => String(n).padStart(2, '0');

/**
 * Read the wall-clock components of `now` in the tenant's zone. We use Intl
 * because `Date` itself only speaks UTC + host-local; a tenant in Colombo
 * running on a Frankfurt host would otherwise flip Friday-night rules to
 * mid-afternoon Friday.
 */
function resolveLocalClock(
  now: Date,
  timeZone: string | undefined,
): { date: string; weekday: number; hours: number; minutes: number } {
  if (!timeZone) {
    return {
      // Host-local components, not `toISOString()`: on a host behind UTC the
      // UTC date is already tomorrow for part of every evening, and this
      // branch's whole premise is "the host's zone is the tenant's zone".
      date: `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`,
      weekday: now.getDay(),
      hours: now.getHours(),
      minutes: now.getMinutes(),
    };
  }
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  // `formatToParts` gives typed pieces; a `weekday: short` part is 'Mon' etc.
  const parts = fmt.formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes, fallback: string): string =>
    parts.find((p) => p.type === type)?.value ?? fallback;
  const dayLabel = part('weekday', 'Sun');
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(dayLabel);
  return {
    date: `${part('year', '1970')}-${part('month', '01')}-${part('day', '01')}`,
    weekday: weekday === -1 ? now.getDay() : weekday,
    // en-US with hour12:false formats midnight as '24'; normalise to 0.
    hours: Number(part('hour', '00')) % 24,
    minutes: Number(part('minute', '00')),
  };
}
