/**
 * Weighted-average cost recomputation for a single receipt line (D44).
 *
 * Pure: no Prisma, no side effects, no argument mutation. The formula is the
 * one the migration comment specifies:
 *
 *   newAvg = (existingQty × existingAvg + receivedQty × unitCost)
 *          / (existingQty + receivedQty)
 *
 * with two edge cases the SQL cannot express in one row:
 *
 *   • `existingAvg` is NULL until the first receipt — the return is unitCost.
 *   • `existingQty` is 0 (variant existed but never received) — the return is
 *     also unitCost, because the sum has no weight to attribute to the old
 *     average.
 *
 * Callers convert Prisma `Decimal` to `number` before invoking. Precision is
 * `Number.EPSILON`-bounded, which is enough for the four decimal places
 * `BranchInventory.averageCost` and `ProductVariant.averageCost` store; a
 * lossless implementation would need Decimal arithmetic and is deferred until
 * one appears necessary.
 */
export function computeWeightedAverage(
  existingQty: number,
  existingAvg: number | null,
  receivedQty: number,
  unitCost: number,
): number {
  if (existingAvg === null || existingQty <= 0) return unitCost;
  const totalQty = existingQty + receivedQty;
  if (totalQty <= 0) return unitCost;
  return (existingQty * existingAvg + receivedQty * unitCost) / totalQty;
}
