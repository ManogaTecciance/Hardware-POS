/**
 * Display helper for a product variant's human-readable name.
 *
 * A `ProductVariant` has no `name` column — its identity is the set of options
 * it carries ("Black", "Medium"), so the readable form is derived. Two callers
 * need the same answer for the same variant and must never disagree:
 *
 *   • `sellable.service` — what the till shows in the variant picker
 *   • `sales.service`    — what is frozen onto the sale line as
 *                          `variantNameSnapshot` (D44) and printed on the receipt
 *
 * If those two ever drifted, a receipt would name a variant differently from the
 * screen the cashier chose it on. Keeping the rule in one place is what prevents
 * that, which is why this lives in `common/` rather than in either module.
 */

export interface VariantOptionValueLike {
  option?: { name: string } | null;
}

/**
 * "Black / Medium", or the SKU when a variant carries no options.
 *
 * The SKU fallback matters: a variant can exist with no option values (a
 * single-variant product, or one authored before its dimensions were), and an
 * empty string on a receipt line is worse than an unlovely code.
 */
export function variantDisplayName(
  optionValues: readonly VariantOptionValueLike[],
  sku: string,
): string {
  if (optionValues.length === 0) return sku;
  return optionValues.map((ov) => ov.option?.name ?? '').join(' / ');
}
