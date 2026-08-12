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
