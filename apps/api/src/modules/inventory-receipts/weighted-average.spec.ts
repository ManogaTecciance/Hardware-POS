import { computeWeightedAverage } from './weighted-average';

describe('computeWeightedAverage', () => {
  it('adopts unitCost when existing average is NULL', () => {
    expect(computeWeightedAverage(0, null, 10, 150)).toBe(150);
    // Even a non-zero existing quantity — a broken invariant, but the safe
    // reading is still "unitCost", not a divide-by-something-unknown.
    expect(computeWeightedAverage(20, null, 10, 150)).toBe(150);
  });

  it('adopts unitCost when existing quantity is zero (variant existed, was drained)', () => {
    expect(computeWeightedAverage(0, 999, 5, 200)).toBe(200);
  });

  it('applies the standard weighted formula for a mix of receipts', () => {
    // 20 units at cost 150, plus 100 units at cost 160 → 19_000 / 120.
    const expected = (20 * 150 + 100 * 160) / 120;
    expect(computeWeightedAverage(20, 150, 100, 160)).toBeCloseTo(expected, 4);
  });

  it('rounds to 158.3333 for the 20@150 + 100@160 canonical case', () => {
    const avg = computeWeightedAverage(20, 150, 100, 160);
    // Four decimal places — the storage precision of BranchInventory.averageCost.
    expect(Number(avg.toFixed(4))).toBe(158.3333);
  });

  it('does not mutate its arguments (they are primitives, but assert on the returned value)', () => {
    const existingQty = 5;
    const existingAvg = 100;
    const receivedQty = 5;
    const unitCost = 200;
    const before = { existingQty, existingAvg, receivedQty, unitCost };
    computeWeightedAverage(existingQty, existingAvg, receivedQty, unitCost);
    expect({ existingQty, existingAvg, receivedQty, unitCost }).toEqual(before);
  });

  it('treats totalQty <= 0 (both zero) as a fallback to unitCost, not a divide-by-zero', () => {
    // Guards a caller that passed zeros on both sides; NaN would poison the
    // per-branch average silently, which is exactly the class of failure D44
    // costs the operator hours to notice.
    expect(computeWeightedAverage(0, 100, 0, 42)).toBe(42);
    expect(Number.isFinite(computeWeightedAverage(0, 100, 0, 42))).toBe(true);
  });
});
