/**
 * How a product's price and SKU read on a list, when the product may have
 * variants (D44).
 *
 * ## Why this exists
 *
 * `Product.unitPrice` and `Product.sku` are authoritative only for legacy,
 * variant-less rows. The schema says so in as many words:
 *
 *   "When true the variant rows own price, cost, SKU, barcode, and per-branch
 *    stock; the parent-level `unitPrice` / `sku` / `quantityOnHand` remain as
 *    legacy fallbacks and are not read."
 *
 * The POS till already honours that (`sellable.service.ts` sends `null` for a
 * variant product's base price and lists the variants separately). The admin
 * screens did not: the products list, the product picker and the product detail
 * KPI all read the parent columns and rendered `Rs 0.00` and `SKU —` against
 * every variant product in the catalogue.
 *
 * Pure, and formatter-injected: the products list formats money as `Rs. 1,850.00`
 * (`@/lib/utils`) and the picker as `LKR 1,850.00` (`@/lib/restaurant/labels`).
 * Taking `money` as an argument keeps both screens rendering exactly the currency
 * style they render today — this change is about which NUMBER is shown, not how
 * it is formatted.
 */

/** The subset of a product these helpers read. */
export interface VariantPricedProduct {
  hasVariants: boolean;
  unitPrice: number;
  sku: string | null;
  variantCount?: number;
  variantPriceMin?: number | null;
  variantPriceMax?: number | null;
}

/**
 * True when the variant rows — not the parent columns — carry this product's
 * price and SKU.
 *
 * Both conditions matter. `hasVariants` alone is not enough: the flag is set
 * when the first variant is created, and a product whose every variant was
 * later deactivated would otherwise show a blank price with nothing to fall
 * back to. Requiring at least one active variant means the parent columns stay
 * in play exactly while they are the only thing left.
 */
export function pricedByVariants(p: VariantPricedProduct): boolean {
  return p.hasVariants && (p.variantCount ?? 0) > 0;
}

/**
 * The Price cell.
 *
 * - Legacy product → its own price, unchanged.
 * - Variants that all agree → that single price, with no misleading range.
 * - Variants that differ → `min – max`, the span an operator can expect at the
 *   till. A range is deliberate: picking one variant's price (the default, say)
 *   would state a specific figure that is wrong for every other variant, and
 *   only 3 of the 48 variants in the pilot catalogue carry `isDefault` at all.
 */
export function variantPriceLabel(
  p: VariantPricedProduct,
  money: (n: number) => string,
): string {
  if (!pricedByVariants(p)) return money(p.unitPrice);

  const min = p.variantPriceMin;
  const max = p.variantPriceMax;
  // Defensive: `pricedByVariants` implies a count, but a bound could still be
  // null on a malformed response. Falling back to the parent price is wrong
  // (it is 0.00); an em dash at least does not assert a false figure.
  if (min == null || max == null) return '—';
  return min === max ? money(min) : `${money(min)} – ${money(max)}`;
}

/**
 * The SKU cell.
 *
 * A variant product has no single SKU — it has several, and which one applies
 * depends on the size and colour the customer picks. Naming the count is the
 * honest answer and tells the operator where to look; the parent `sku` is null
 * on every such row anyway, so the old `—` said nothing at all.
 */
export function variantSkuLabel(p: VariantPricedProduct): string {
  if (!pricedByVariants(p)) return p.sku ?? '—';
  const n = p.variantCount ?? 0;
  return n === 1 ? '1 variant' : `${n} variants`;
}
