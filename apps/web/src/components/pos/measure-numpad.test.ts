/**
 * D113 (`6.3`) — what the weight keypad will and will not accept.
 *
 * ## What makes these assertions non-vacuous (D30)
 *
 * The decimal cap is asserted at its boundary from BOTH sides: three places are
 * accepted, a fourth is refused. A test that only checked the refusal would pass
 * for a keypad that accepted nothing after the point at all, which would make
 * every weighed sale impossible rather than merely imprecise.
 *
 * `appendKey` is exported for exactly this: the keypad's rules are a pure string
 * function, and testing them through a rendered dialog would prove less and cost
 * more.
 */

import { describe, expect, it } from 'vitest';

import { appendKey } from './measure-numpad';

describe('the weight keypad', () => {
  it('builds an ordinary number', () => {
    expect(appendKey('', '7')).toBe('7');
    expect(appendKey('7', '5')).toBe('75');
    expect(appendKey('0.7', '5')).toBe('0.75');
  });

  it('leads a bare decimal point with a zero', () => {
    // A cashier keying `.5` means 500 g. `.5` alone is not a number a `Number()`
    // round trip keeps, and `0.5` is unambiguous on the display.
    expect(appendKey('', '.')).toBe('0.');
  });

  it('allows only one decimal point', () => {
    expect(appendKey('0.7', '.')).toBe('0.7');
  });

  it('replaces a leading zero rather than growing it', () => {
    // `0` then `5` is 5, not "05".
    expect(appendKey('0', '5')).toBe('5');
    // But `0.` must survive, or a fraction can never be typed.
    expect(appendKey('0.', '5')).toBe('0.5');
  });

  it('accepts three decimal places', () => {
    // The POSITIVE side of the boundary: `Decimal(12,3)` is grams, and 1.235 kg
    // is a real weight a scale shows.
    expect(appendKey('1.23', '5')).toBe('1.235');
  });

  it('refuses a fourth decimal place', () => {
    // D113b §3 — the database silently truncates the fourth place, so it is
    // refused where the operator can still see it rather than after the fact.
    expect(appendKey('1.235', '9')).toBe('1.235');
  });

  it('counts places after the point only', () => {
    // A long whole part is fine — 1250 kg of anything is a real delivery. The
    // cap is on precision, not magnitude.
    expect(appendKey('125', '0')).toBe('1250');
  });
});
