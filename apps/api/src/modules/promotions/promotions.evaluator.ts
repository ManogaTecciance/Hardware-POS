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

  if (promotion.startsOn && now < promotion.startsOn) return false;
  if (promotion.endsOn && now > promotion.endsOn) return false;

  // Wall-clock components read in the tenant zone if supplied. Falling back
  // to host-local (Intl with the runtime default) is the same behaviour the
  // MenuAvailability check uses today.
  const local = resolveLocalClock(now, context.tenantTimeZone);

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
 * Read the wall-clock components of `now` in the tenant's zone. We use Intl
 * because `Date` itself only speaks UTC + host-local; a tenant in Colombo
 * running on a Frankfurt host would otherwise flip Friday-night rules to
 * mid-afternoon Friday.
 */
function resolveLocalClock(
  now: Date,
  timeZone: string | undefined,
): { weekday: number; hours: number; minutes: number } {
  if (!timeZone) {
    return { weekday: now.getDay(), hours: now.getHours(), minutes: now.getMinutes() };
  }
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  // `formatToParts` gives typed pieces; a `weekday: short` part is 'Mon' etc.
  const parts = fmt.formatToParts(now);
  const dayLabel = parts.find((p) => p.type === 'weekday')?.value ?? 'Sun';
  const hourStr = parts.find((p) => p.type === 'hour')?.value ?? '00';
  const minuteStr = parts.find((p) => p.type === 'minute')?.value ?? '00';
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(dayLabel);
  return {
    weekday: weekday === -1 ? now.getDay() : weekday,
    // en-US with hour12:false formats midnight as '24'; normalise to 0.
    hours: Number(hourStr) % 24,
    minutes: Number(minuteStr),
  };
}
