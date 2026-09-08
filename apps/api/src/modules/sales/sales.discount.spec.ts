import { computeDiscount } from './sales.service';

/**
 * The authoritative discount arithmetic — this is the copy that decides what the
 * customer actually pays. It must agree to the cent with the client's copy in
 * apps/web/src/lib/cart.ts, because a one-cent disagreement leaves the sale
 * short and it completes as part-paid instead of paid.
 */
describe('the money taken off a line', () => {
  it('takes a fixed amount once for a whole-line discount', () => {
    expect(computeDiscount(3000, 'FIXED', 100, { basis: 'LINE', quantity: 3 })).toBe(100);
  });

  it('takes a fixed amount from every unit for a per-unit discount', () => {
    expect(computeDiscount(3000, 'FIXED', 100, { basis: 'UNIT', quantity: 3 })).toBe(300);
  });

  it('treats an absent basis as whole-line', () => {
    // Every sale rung up before per-unit existed, and every caller that has no
    // units to speak of.
    expect(computeDiscount(3000, 'FIXED', 100)).toBe(100);
    expect(computeDiscount(3000, 'FIXED', 100, { quantity: 3 })).toBe(100);
  });

  it('ignores the basis on a percentage', () => {
    expect(computeDiscount(3000, 'PERCENTAGE', 10, { basis: 'UNIT', quantity: 3 })).toBe(300);
  });

  it('never exceeds the line, so a line can never go negative', () => {
    expect(computeDiscount(3000, 'FIXED', 2000, { basis: 'UNIT', quantity: 3 })).toBe(3000);
    expect(computeDiscount(3000, 'FIXED', 99999, { basis: 'LINE' })).toBe(3000);
  });

  it('multiplies before rounding', () => {
    // round2(33.333 * 3) = 100.00; rounding each unit first gives 99.99.
    expect(computeDiscount(3000, 'FIXED', 33.333, { basis: 'UNIT', quantity: 3 })).toBe(100);
  });

  it('takes nothing when there is no discount', () => {
    expect(computeDiscount(3000, null, null)).toBe(0);
    expect(computeDiscount(3000, 'FIXED', 0, { basis: 'UNIT', quantity: 3 })).toBe(0);
  });

  it('handles a fractional quantity, which the API accepts', () => {
    // Quantity is Decimal(12,3): 2.5 metres of cable at Rs. 10 off per unit.
    expect(computeDiscount(1000, 'FIXED', 10, { basis: 'UNIT', quantity: 2.5 })).toBe(25);
  });
});
