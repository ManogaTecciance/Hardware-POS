/**
 * A time window that can never contain a moment is a typo, not a schedule.
 *
 * ## What was wrong
 *
 * `isPromotionActive` reads `startTime`/`endTime` as the half-open interval
 * `[start, end)` and has no overnight wrap. Nothing checked the pair, so two
 * shapes saved cleanly and produced a promotion that is switched on, reads
 * "Active" in the list, and can never fire on any day: `start === end`, and
 * `start > end` (an operator's evening offer, 18:00–09:00).
 *
 * A third shape is legal but nearly always accidental. An operator lost the best
 * part of an hour to a bundle scheduled `12:56–12:57`: Chrome's native
 * `<input type="time">` inserts the current clock time when its icon is clicked,
 * so a one-minute window appears without anyone typing one. For the other 1,439
 * minutes of the day it is indistinguishable from a broken promotion.
 *
 * ## What makes these assertions non-vacuous (D30)
 *
 * The good windows are asserted alongside the bad ones. "18:00–09:00 is an
 * error" alone would pass for a helper that complained about every window,
 * including the all-day blank pair that is the normal case — which would put a
 * red banner on nearly every promotion in the system. Every rejection case
 * therefore has an acceptance counterpart.
 *
 * Levels are asserted, not just presence: the difference between `error` (the
 * server will refuse this) and `warn` (unusual, allowed, said out loud) is the
 * whole design, and a helper that returned `error` for both would block a flash
 * sale that is a legitimate thing to want.
 */
import { describe, expect, it } from 'vitest';

import {
  SHORT_WINDOW_MINUTES,
  describeTimeWindow,
  toMinutesOfDay,
} from './promotion-schedule';

describe('toMinutesOfDay', () => {
  it('parses a wall-clock string the way the evaluator does', () => {
    expect(toMinutesOfDay('00:00')).toBe(0);
    expect(toMinutesOfDay('12:56')).toBe(776);
    expect(toMinutesOfDay('23:59')).toBe(1439);
  });

  it('refuses what is not that shape, rather than coercing it', () => {
    // NaN arithmetic would make `start > end` silently false and disable the
    // whole guard, so each of these must come back null.
    expect(toMinutesOfDay('')).toBeNull();
    expect(toMinutesOfDay('9:30')).toBeNull();
    expect(toMinutesOfDay('24:00')).toBeNull();
    expect(toMinutesOfDay('12:60')).toBeNull();
    expect(toMinutesOfDay('lunchtime')).toBeNull();
  });
});

describe('describeTimeWindow — the windows that are fine', () => {
  it('says nothing at all when both are blank (all day)', () => {
    // The overwhelmingly common shape. A notice here would put a banner on
    // nearly every promotion in the system.
    expect(describeTimeWindow('', '')).toBeNull();
  });

  it('says nothing about an ordinary window', () => {
    expect(describeTimeWindow('09:00', '17:00')).toBeNull();
    expect(describeTimeWindow('00:00', '23:59')).toBeNull();
    // Exactly at the threshold is fine — the warning is for windows BELOW it.
    expect(describeTimeWindow('12:00', `12:${String(SHORT_WINDOW_MINUTES).padStart(2, '0')}`))
      .toBeNull();
  });

  it('stays quiet while the operator is still typing', () => {
    // `type="time"` will not submit a malformed value, and complaining mid-edit
    // on a field nobody has finished with is noise, not help.
    expect(describeTimeWindow('1', '17:00')).toBeNull();
    expect(describeTimeWindow('09:00', '9')).toBeNull();
  });
});

describe('describeTimeWindow — the windows that can never fire', () => {
  it('rejects an empty interval', () => {
    const n = describeTimeWindow('12:56', '12:56');
    expect(n?.level).toBe('error');
    expect(n?.message).toContain('could never be active');
  });

  it('rejects a window that would have to cross midnight', () => {
    // The shape an operator writes meaning "evening through morning". The
    // evaluator has no wrap, so this is silence, every day.
    const n = describeTimeWindow('18:00', '09:00');
    expect(n?.level).toBe('error');
    expect(n?.message).toContain('could never be active');
    // …and it must say what to do instead, naming the operator's own times.
    expect(n?.message).toContain('18:00–23:59');
    expect(n?.message).toContain('00:00–09:00');
  });

  it('rejects a half-open pair', () => {
    // The server refuses this too; catching it here turns a save error into a
    // note beside the field that caused it.
    expect(describeTimeWindow('09:00', '')?.level).toBe('error');
    expect(describeTimeWindow('', '17:00')?.level).toBe('error');
  });
});

describe('describeTimeWindow — the window that is legal but suspicious', () => {
  it('warns, and does not block, a one-minute window', () => {
    const n = describeTimeWindow('12:56', '12:57');
    // WARN, not error: a flash sale is a real thing to want, so this is said
    // out loud and allowed. Asserting the level is the point — an `error` here
    // would refuse a legitimate promotion.
    expect(n?.level).toBe('warn');
    expect(n?.message).toContain('1 minute a day');
    expect(n?.message).toContain('12:56–12:57');
  });

  it('pluralises, and reports the real duration', () => {
    const n = describeTimeWindow('12:00', '12:05');
    expect(n?.level).toBe('warn');
    expect(n?.message).toContain('5 minutes a day');
  });

  it('warns right up to the threshold and not beyond it', () => {
    // The boundary asserted from both sides, so a `<=`/`<` slip is caught.
    expect(describeTimeWindow('12:00', '12:14')?.level).toBe('warn');
    expect(describeTimeWindow('12:00', '12:15')).toBeNull();
  });
});
