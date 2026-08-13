import { Prisma } from '@hardware-pos/database';

import { allocateSplitShares, lineTotal } from './split-shares';

const d = (v: string | number) => new Prisma.Decimal(v);
const sum = (xs: Prisma.Decimal[]) => xs.reduce((a, b) => a.plus(b), d(0));

describe('D51 — split share allocation', () => {
  it('splits a clean bill by item value', () => {
    // Two friends, no service charge: each pays exactly what they ate.
    const shares = allocateSplitShares({
      itemSubtotals: [d('600.00'), d('400.00')],
      subtotal: d('1000.00'),
      total: d('1000.00'),
    });
    expect(shares.map(String)).toEqual(['600', '400']);
    expect(sum(shares).equals(d('1000.00'))).toBe(true);
  });

  it('spreads service charge pro rata, not evenly', () => {
    // 10% service on a 60/40 split lands 60/40, not 50/50.
    const shares = allocateSplitShares({
      itemSubtotals: [d('600.00'), d('400.00')],
      subtotal: d('1000.00'),
      total: d('1100.00'),
    });
    expect(shares.map((s) => s.toFixed(2))).toEqual(['660.00', '440.00']);
    expect(sum(shares).equals(d('1100.00'))).toBe(true);
  });

  it('sums to the total EXACTLY when the maths does not divide (the load-bearing rule)', () => {
    // Three ways on 100.00 is 33.333…; naive rounding gives 99.99 or 100.02,
    // and either leaves the bill unpayable.
    const shares = allocateSplitShares({
      itemSubtotals: [d('33.33'), d('33.33'), d('33.34')],
      subtotal: d('100.00'),
      total: d('110.00'),
    });
    expect(sum(shares).equals(d('110.00'))).toBe(true);
    for (const s of shares) expect(s.decimalPlaces()).toBeLessThanOrEqual(2);
  });

  it.each([
    ['1000.00', '1150.00', 7],
    ['999.99', '1087.49', 3],
    ['0.03', '0.03', 3],
    ['12345.67', '13580.24', 11],
  ])('never drifts: subtotal %s → total %s across %i splits', (subtotal, total, n) => {
    // Equal-ish weights are the worst case for remainder distribution.
    const each = d(subtotal).div(n);
    const itemSubtotals = Array.from({ length: n }, () => each);
    const shares = allocateSplitShares({ itemSubtotals, subtotal: d(subtotal), total: d(total) });
    expect(sum(shares).equals(d(total))).toBe(true);
  });

  it('gives the leftover cent to the largest fractional part, deterministically', () => {
    const input = {
      itemSubtotals: [d('10.00'), d('20.00'), d('0.01')],
      subtotal: d('30.01'),
      total: d('33.01'),
    };
    const once = allocateSplitShares(input).map((s) => s.toFixed(2));
    const twice = allocateSplitShares(input).map((s) => s.toFixed(2));
    expect(once).toEqual(twice);
    expect(sum(allocateSplitShares(input)).equals(d('33.01'))).toBe(true);
  });

  it('handles a fully comped tab with a flat charge — no divide-by-zero', () => {
    const shares = allocateSplitShares({
      itemSubtotals: [d(0), d(0)],
      subtotal: d(0),
      total: d('5.00'),
    });
    expect(sum(shares).equals(d('5.00'))).toBe(true);
    expect(shares.map((s) => s.toFixed(2))).toEqual(['2.50', '2.50']);
  });

  it('handles a discounted bill where total is BELOW subtotal', () => {
    const shares = allocateSplitShares({
      itemSubtotals: [d('50.00'), d('50.00')],
      subtotal: d('100.00'),
      total: d('90.00'),
    });
    expect(sum(shares).equals(d('90.00'))).toBe(true);
    expect(shares.every((s) => s.greaterThan(0))).toBe(true);
  });

  it('returns nothing for no splits, and everything for one', () => {
    expect(allocateSplitShares({ itemSubtotals: [], subtotal: d(0), total: d(0) })).toEqual([]);
    const [only] = allocateSplitShares({
      itemSubtotals: [d('80.00')],
      subtotal: d('80.00'),
      total: d('92.00'),
    });
    expect(only!.equals(d('92.00'))).toBe(true);
  });

  it('lineTotal multiplies the modifier-inclusive unit price', () => {
    expect(lineTotal(d('250.00'), d('50.00'), d('3')).toFixed(2)).toBe('900.00');
    expect(lineTotal(d('250.00'), d(0), d('0.5')).toFixed(2)).toBe('125.00');
  });
});
