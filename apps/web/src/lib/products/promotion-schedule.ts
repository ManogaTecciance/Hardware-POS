/**
 * What a promotion's time-of-day window will actually do, said in the editor
 * before it is saved.
 *
 * ## Why this exists
 *
 * `isPromotionActive` reads `startTime`/`endTime` as the half-open interval
 * `[start, end)` — `minutesNow < start || minutesNow >= end` is out — and has no
 * overnight wrap. Two shapes therefore produce a promotion that is switched on,
 * reads as on in the list, and can never fire on any day:
 *
 *   • `start === end` — an empty interval;
 *   • `start > end`   — e.g. 18:00–09:00, which an operator reasonably reads as
 *     "evening through morning" and the evaluator reads as nothing at all.
 *
 * A third shape is legal but almost always an accident: a window of a minute or
 * two. Chrome's native `<input type="time">` inserts the current clock time when
 * the clock icon is clicked, so "12:56 to 12:57" appears without anyone typing
 * it — and a promotion that works for sixty seconds a day looks, for the rest of
 * the day, exactly like a broken promotion.
 *
 * The server refuses the first two (`promotions.service.ts`). This helper is the
 * same judgement one step earlier, so the operator reads it beside the fields
 * rather than as a save error, plus the warning the server deliberately does not
 * raise — a two-minute flash sale is a real thing to want, so it is said out
 * loud and allowed.
 *
 * Pure and formatter-free: the caller decides how to render each level.
 */

/** Below this, a window is more likely a mis-click than an intention. */
export const SHORT_WINDOW_MINUTES = 15;

export type ScheduleNoticeLevel = 'warn' | 'error';

export interface ScheduleNotice {
  level: ScheduleNoticeLevel;
  message: string;
}

/** `"HH:MM"` → minutes since midnight, or null if it is not that shape. */
export function toMinutesOfDay(value: string): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(value);
  if (!m) return null;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/**
 * Null when the window is fine — including when both fields are blank, which
 * means "all day" and is the normal case.
 */
export function describeTimeWindow(
  startTime: string,
  endTime: string,
): ScheduleNotice | null {
  const hasStart = startTime.trim() !== '';
  const hasEnd = endTime.trim() !== '';

  // All day. The overwhelmingly common shape, and the one to say nothing about.
  if (!hasStart && !hasEnd) return null;

  if (hasStart !== hasEnd) {
    return {
      level: 'error',
      message:
        'Set both a start and an end time, or clear both to run all day. The server refuses a half-open window.',
    };
  }

  const start = toMinutesOfDay(startTime);
  const end = toMinutesOfDay(endTime);
  // Unparseable is the browser's problem, not a schedule problem: `type="time"`
  // will not submit a malformed value, and inventing a complaint here would
  // fire mid-typing on a field the operator has not finished with.
  if (start === null || end === null) return null;

  if (start === end) {
    return {
      level: 'error',
      message: `Start and end are both ${startTime}, so this promotion could never be active. Widen the window, or clear both to run all day.`,
    };
  }

  if (start > end) {
    return {
      level: 'error',
      message: `${startTime} is after ${endTime}, so this promotion could never be active. A window cannot cross midnight — use two promotions (e.g. ${startTime}–23:59 and 00:00–${endTime}).`,
    };
  }

  const minutes = end - start;
  if (minutes < SHORT_WINDOW_MINUTES) {
    return {
      level: 'warn',
      message: `This promotion will only be active for ${minutes} ${
        minutes === 1 ? 'minute' : 'minutes'
      } a day (${startTime}–${endTime}). Clear both times to run all day.`,
    };
  }

  return null;
}
