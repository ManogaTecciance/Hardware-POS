import { PromotionScheduleShape, isPromotionActive } from './promotions.evaluator';

/**
 * Every case is a POSITIVE ↔ NEGATIVE pair so a broken evaluator that always
 * returns `true` (or always returns `false`) fails at least one arm. This is
 * the D30 mutation-proof shape — a green suite here is a specific claim about
 * both the accept and the reject path, not a "the function ran" signal.
 */
function baseline(): PromotionScheduleShape {
  return {
    isActive: true,
    startsOn: null,
    endsOn: null,
    daysOfWeek: [],
    startTime: null,
    endTime: null,
    branchScope: [],
    channelScope: [],
  };
}

describe('promotions evaluator — schedule matcher', () => {
  const NOON_FRI = new Date('2026-08-14T12:00:00Z'); // Friday 2026-08-14 UTC noon.

  it('an unscoped, always-on, active promotion is valid', () => {
    // POSITIVE CONTROL: with every schedule column empty the evaluator must
    // pass. Every other test below tightens exactly one column, so if this
    // fails they are all evaluating a broken baseline.
    expect(isPromotionActive(baseline(), { now: NOON_FRI })).toBe(true);
  });

  it('isActive=false always fails', () => {
    expect(
      isPromotionActive({ ...baseline(), isActive: false }, { now: NOON_FRI }),
    ).toBe(false);
  });

  describe('date range', () => {
    it('startsOn in the past + endsOn in the future is valid', () => {
      expect(
        isPromotionActive(
          {
            ...baseline(),
            startsOn: new Date('2026-01-01T00:00:00Z'),
            endsOn: new Date('2026-12-31T23:59:59Z'),
          },
          { now: NOON_FRI },
        ),
      ).toBe(true);
    });

    it('startsOn in the future is not valid', () => {
      expect(
        isPromotionActive(
          { ...baseline(), startsOn: new Date('2027-01-01T00:00:00Z') },
          { now: NOON_FRI },
        ),
      ).toBe(false);
    });

    it('endsOn in the past is not valid', () => {
      expect(
        isPromotionActive(
          { ...baseline(), endsOn: new Date('2025-01-01T00:00:00Z') },
          { now: NOON_FRI },
        ),
      ).toBe(false);
    });

    /*
     * D139 — a date is a whole day in the tenant's zone, at BOTH ends.
     *
     * The editor sends `type="date"`, so the column holds UTC midnight of the
     * day that was typed. Compared as an instant, "ends 30 Sep" expired at
     * 00:00 UTC on the 30th — 05:30 for a Colombo tenant, so the promotion was
     * dead for almost all of the final day it was meant to run.
     *
     * Every case below is a live/dead pair around one boundary, and each pair
     * is chosen so the OLD instant comparison fails one arm: a green suite
     * here is a claim about the inclusive day, not about the function running.
     *
     * MUTATION-PROVEN (2026-09-09): restoring the old two lines —
     *   if (promotion.startsOn && now < promotion.startsOn) return false;
     *   if (promotion.endsOn && now > promotion.endsOn) return false;
     * fails exactly three of these cases ("is still live late on its final
     * day", "is live from the first minute of its start date", and "an end
     * date follows the tenant across the date line too") and leaves the rest
     * green. The two dead-side arms passing under both implementations is
     * correct and is why they are not the proof: the live-side arms are.
     */
    describe('a date is a whole day in the tenant zone', () => {
      const ENDS = new Date('2026-09-30T00:00:00Z'); // what "ends 30 Sep" stores.
      const COLOMBO = 'Asia/Colombo'; // UTC+5:30.

      it('is still live late on its final day', () => {
        // 2026-09-30 23:00 in Colombo. The old comparison had this expired for
        // seventeen and a half hours by now.
        const lateOnTheLastDay = new Date('2026-09-30T17:30:00Z');
        expect(
          isPromotionActive(
            { ...baseline(), endsOn: ENDS },
            { now: lateOnTheLastDay, tenantTimeZone: COLOMBO },
          ),
        ).toBe(true);
      });

      it('is dead once the tenant’s next day begins', () => {
        // 2026-10-01 00:30 in Colombo — the first minutes of the day after.
        const justAfterMidnight = new Date('2026-09-30T19:00:00Z');
        expect(
          isPromotionActive(
            { ...baseline(), endsOn: ENDS },
            { now: justAfterMidnight, tenantTimeZone: COLOMBO },
          ),
        ).toBe(false);
      });

      it('is live from the first minute of its start date, not from UTC midnight', () => {
        // 2026-09-30 00:30 in Colombo is 2026-09-29T19:00Z — BEFORE the stored
        // instant, so the old comparison held the promotion back until 05:30
        // local on the day it was supposed to start.
        const justAfterMidnight = new Date('2026-09-29T19:00:00Z');
        expect(
          isPromotionActive(
            { ...baseline(), startsOn: ENDS },
            { now: justAfterMidnight, tenantTimeZone: COLOMBO },
          ),
        ).toBe(true);
      });

      it('is not live on the day before it starts', () => {
        // 2026-09-29 23:00 Colombo — one hour earlier, one day earlier.
        const dayBefore = new Date('2026-09-29T17:30:00Z');
        expect(
          isPromotionActive(
            { ...baseline(), startsOn: ENDS },
            { now: dayBefore, tenantTimeZone: COLOMBO },
          ),
        ).toBe(false);
      });
    });
  });

  /*
   * D139 — the same instant, read on two clocks.
   *
   * Asserting against a fixed zone alone would pass on a host that happens to
   * sit in it. Each case here evaluates ONE `now` against TWO zones and
   * expects opposite answers, so the only way both arms pass is if the zone is
   * actually being honoured.
   */
  describe('the schedule is read on the tenant’s clock', () => {
    it('a lunch window follows the tenant, not the server', () => {
      // 06:30 UTC is noon in Colombo and half past six in the morning in London.
      const now = new Date('2026-09-09T06:30:00Z');
      const lunch = { ...baseline(), startTime: '11:00', endTime: '15:00' };

      expect(isPromotionActive(lunch, { now, tenantTimeZone: 'Asia/Colombo' })).toBe(true);
      expect(isPromotionActive(lunch, { now, tenantTimeZone: 'Europe/London' })).toBe(false);
    });

    it('a day-of-week rule follows the tenant across the date line', () => {
      // Friday 20:00 UTC is already Saturday morning in Kiritimati (UTC+14).
      const now = new Date('2026-08-14T20:00:00Z');
      const fridays = { ...baseline(), daysOfWeek: ['FRI'] };

      expect(isPromotionActive(fridays, { now, tenantTimeZone: 'UTC' })).toBe(true);
      expect(isPromotionActive(fridays, { now, tenantTimeZone: 'Pacific/Kiritimati' })).toBe(false);
    });

    it('an end date follows the tenant across the date line too', () => {
      const now = new Date('2026-08-14T20:00:00Z');
      const endsFriday = { ...baseline(), endsOn: new Date('2026-08-14T00:00:00Z') };

      expect(isPromotionActive(endsFriday, { now, tenantTimeZone: 'UTC' })).toBe(true);
      // Already Saturday there, so a promotion that ended Friday is over.
      expect(
        isPromotionActive(endsFriday, { now, tenantTimeZone: 'Pacific/Kiritimati' }),
      ).toBe(false);
    });
  });

  describe('day of week', () => {
    it("daysOfWeek=['FRI'] on a Friday is valid", () => {
      expect(
        isPromotionActive({ ...baseline(), daysOfWeek: ['FRI'] }, { now: NOON_FRI }),
      ).toBe(true);
    });

    it("daysOfWeek=['FRI'] on a Thursday is not valid", () => {
      const thursday = new Date('2026-08-13T12:00:00Z');
      expect(
        isPromotionActive({ ...baseline(), daysOfWeek: ['FRI'] }, { now: thursday }),
      ).toBe(false);
    });

    it('empty daysOfWeek is a pass-through', () => {
      // NEGATIVE-guard: if the evaluator treated `[]` as "no day matches"
      // every unscoped promotion would silently go dark.
      expect(
        isPromotionActive({ ...baseline(), daysOfWeek: [] }, { now: NOON_FRI }),
      ).toBe(true);
    });
  });

  describe('time of day', () => {
    // 18:30 UTC on Friday.
    const evening = new Date('2026-08-14T18:30:00Z');
    // 15:00 UTC on Friday.
    const midAfternoon = new Date('2026-08-14T15:00:00Z');

    it('17:00–22:00 covers 18:30', () => {
      expect(
        isPromotionActive(
          { ...baseline(), startTime: '17:00', endTime: '22:00' },
          { now: evening, tenantTimeZone: 'UTC' },
        ),
      ).toBe(true);
    });

    it('17:00–22:00 excludes 15:00', () => {
      expect(
        isPromotionActive(
          { ...baseline(), startTime: '17:00', endTime: '22:00' },
          { now: midAfternoon, tenantTimeZone: 'UTC' },
        ),
      ).toBe(false);
    });
  });

  describe('branch scope', () => {
    it("branchScope=['brn_a'] with branchId='brn_a' is valid", () => {
      expect(
        isPromotionActive(
          { ...baseline(), branchScope: ['brn_a'] },
          { now: NOON_FRI, branchId: 'brn_a' },
        ),
      ).toBe(true);
    });

    it("branchScope=['brn_a'] with branchId='brn_b' is not valid", () => {
      expect(
        isPromotionActive(
          { ...baseline(), branchScope: ['brn_a'] },
          { now: NOON_FRI, branchId: 'brn_b' },
        ),
      ).toBe(false);
    });

    it('a non-empty scope with no branchId is not valid — an unscoped read must not silently pass a scoped promotion', () => {
      expect(
        isPromotionActive(
          { ...baseline(), branchScope: ['brn_a'] },
          { now: NOON_FRI },
        ),
      ).toBe(false);
    });

    it('empty branchScope is a pass-through', () => {
      expect(
        isPromotionActive(baseline(), { now: NOON_FRI, branchId: 'brn_a' }),
      ).toBe(true);
    });
  });

  describe('channel scope', () => {
    it("channelScope=['DINE_IN'] with channel='DINE_IN' is valid", () => {
      expect(
        isPromotionActive(
          { ...baseline(), channelScope: ['DINE_IN'] },
          { now: NOON_FRI, channel: 'DINE_IN' },
        ),
      ).toBe(true);
    });

    it("channelScope=['DINE_IN'] with channel='TAKEAWAY' is not valid", () => {
      expect(
        isPromotionActive(
          { ...baseline(), channelScope: ['DINE_IN'] },
          { now: NOON_FRI, channel: 'TAKEAWAY' },
        ),
      ).toBe(false);
    });

    it('a non-empty scope with no channel is not valid', () => {
      expect(
        isPromotionActive(
          { ...baseline(), channelScope: ['DINE_IN'] },
          { now: NOON_FRI },
        ),
      ).toBe(false);
    });

    it('empty channelScope is a pass-through', () => {
      expect(
        isPromotionActive(baseline(), { now: NOON_FRI, channel: 'TAKEAWAY' }),
      ).toBe(true);
    });
  });

  describe('mutation-proof: every accept has a matching reject', () => {
    // If the evaluator regressed to `return true`, one of these two rows would
    // still catch it. The pair keeps the mostly-accept suite above honest.
    it('a fully-scoped promotion accepts its exact context', () => {
      const fri17 = new Date('2026-08-14T17:30:00Z');
      const promo: PromotionScheduleShape = {
        isActive: true,
        startsOn: new Date('2026-01-01'),
        endsOn: new Date('2027-01-01'),
        daysOfWeek: ['FRI'],
        startTime: '17:00',
        endTime: '22:00',
        branchScope: ['brn_a'],
        channelScope: ['DINE_IN'],
      };
      expect(
        isPromotionActive(promo, {
          now: fri17,
          branchId: 'brn_a',
          channel: 'DINE_IN',
          tenantTimeZone: 'UTC',
        }),
      ).toBe(true);
    });

    it('the same promotion rejects a mismatched channel', () => {
      const fri17 = new Date('2026-08-14T17:30:00Z');
      const promo: PromotionScheduleShape = {
        isActive: true,
        startsOn: new Date('2026-01-01'),
        endsOn: new Date('2027-01-01'),
        daysOfWeek: ['FRI'],
        startTime: '17:00',
        endTime: '22:00',
        branchScope: ['brn_a'],
        channelScope: ['DINE_IN'],
      };
      expect(
        isPromotionActive(promo, {
          now: fri17,
          branchId: 'brn_a',
          channel: 'TAKEAWAY',
          tenantTimeZone: 'UTC',
        }),
      ).toBe(false);
    });
  });
});
