/**
 * The words the restaurant screens use for things (D177 for the send label).
 *
 * `sendLabel` is one function feeding five surfaces — the board ribbon, the
 * ticket dialog, the history table, the bill sheet and the printed KOT — so a
 * mistake in it is a mistake on every piece of paper the kitchen holds. The
 * ordinal rule has one trap, and it is the one everybody gets wrong once:
 * 11, 12 and 13 take "th", not the suffix their last digit suggests.
 */
import { describe, expect, it } from 'vitest';

import { sendLabel } from './labels';

describe('sendLabel', () => {
  it('spells the first three sends the way English does', () => {
    expect(sendLabel(1)).toBe('1st send');
    expect(sendLabel(2)).toBe('2nd send');
    expect(sendLabel(3)).toBe('3rd send');
    expect(sendLabel(4)).toBe('4th send');
  });

  it('gives the teens "th", whatever their last digit', () => {
    /*
     * The trap. A last-digit rule alone says "11st", "12nd", "13rd" — and a
     * table that has sent eleven times in an evening is not so rare on a long
     * booking that this would never print.
     */
    expect(sendLabel(11)).toBe('11th send');
    expect(sendLabel(12)).toBe('12th send');
    expect(sendLabel(13)).toBe('13th send');
    // …and the rule resumes after them.
    expect(sendLabel(21)).toBe('21st send');
    expect(sendLabel(22)).toBe('22nd send');
    expect(sendLabel(23)).toBe('23rd send');
    // NEGATIVE — the teen exception is about 11–13, not about anything
    // ending in 1–3: 111 is a teen again, 101 is not.
    expect(sendLabel(111)).toBe('111th send');
    expect(sendLabel(101)).toBe('101st send');
  });

  it('never says "Round"', () => {
    // The word the PO asked to retire, asserted absent across a spread of
    // inputs rather than one, so a fallback branch cannot smuggle it back.
    for (const n of [1, 2, 3, 4, 11, 12, 13, 21, 100]) {
      expect(sendLabel(n)).not.toMatch(/round/i);
      expect(sendLabel(n)).toMatch(/ send$/);
    }
  });
});
