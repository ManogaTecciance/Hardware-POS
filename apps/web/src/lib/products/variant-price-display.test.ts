/**
 * D44 — a variant product's price and SKU come from its variants.
 *
 * ## What was wrong
 *
 * The products list, the product picker and the product-detail KPI all read
 * `Product.unitPrice` and `Product.sku`. The schema says in as many words that
 * those are legacy fallbacks and "are not read" once `hasVariants` is true, and
 * the data agreed: every variant product in the pilot catalogue carried
 * `sku = null, unitPrice = 0`, so the whole Price column read `Rs 0.00` while
 * the variants behind it were priced 500 to 4,300.
 *
 * ## What makes these assertions non-vacuous (D30)
 *
 * Legacy and variant products are asserted against each other in the same
 * suite. "A variant product shows a range" alone would pass for a helper that
 * ignored `hasVariants` and ranged everything — which would break the 40-odd
 * legacy hardware and restaurant products that are priced correctly today.
 * Every variant case therefore has a legacy counterpart asserting the old
 * reading is untouched.
 *
 * The injected formatter is asserted too: `formatMoney` differs between the two
 * screens (`Rs. ` vs `LKR `), and the point of injecting it is that neither
 * screen's currency rendering changes.
 */
import { describe, expect, it } from 'vitest';

import {
  pricedByVariants,
  variantPriceLabel,
  variantSkuLabel,
  type VariantPricedProduct,
} from '@hardware-pos/shared';

/** Stands in for either screen's formatter; distinctive so it can be asserted. */
const money = (n: number) => `Rs. ${n.toFixed(2)}`;

function product(over: Partial<VariantPricedProduct> = {}): VariantPricedProduct {
  return {
    hasVariants: false,
    unitPrice: 2650,
    sku: 'CEM-50',
    variantCount: 0,
    variantPriceMin: null,
    variantPriceMax: null,
    ...over,
  };
}

/** Real rows from the pilot catalogue, so the fixture is the production shape. */
const CEMENT = product();
const TIE = product({
  hasVariants: true,
  unitPrice: 0,
  sku: null,
  variantCount: 3,
  variantPriceMin: 500,
  variantPriceMax: 500,
});
const SHORT_PANTS = product({
  hasVariants: true,
  unitPrice: 0,
  sku: null,
  variantCount: 13,
  variantPriceMin: 1200,
  variantPriceMax: 4300,
});

describe('pricedByVariants', () => {
  it('is true only when the flag AND at least one active variant agree', () => {
    // POSITIVE
    expect(pricedByVariants(TIE)).toBe(true);
    // NEGATIVE: a legacy product is never priced by variants…
    expect(pricedByVariants(CEMENT)).toBe(false);
    // …and neither is one whose variants have all been deactivated. Without
    // this the screen would show a blank price with nothing to fall back to.
    expect(pricedByVariants(product({ hasVariants: true, variantCount: 0 }))).toBe(false);
  });

  it('treats an aggregate-less response as legacy rather than as zero variants', () => {
    // A response predating the aggregate omits the field entirely. Reading the
    // parent price is the old behaviour, which is correct for every row that
    // could have been served by that older API.
    const old = { hasVariants: true, unitPrice: 1500, sku: 'X-1' };
    expect(pricedByVariants(old)).toBe(false);
    expect(variantPriceLabel(old, money)).toBe('Rs. 1500.00');
  });
});

describe('variantPriceLabel', () => {
  it('leaves a legacy product exactly as it reads today', () => {
    expect(variantPriceLabel(CEMENT, money)).toBe('Rs. 2650.00');
  });

  it('shows one price when every variant agrees, not a range', () => {
    // All three ties are 500. `Rs. 500.00 – Rs. 500.00` would be noise.
    expect(variantPriceLabel(TIE, money)).toBe('Rs. 500.00');
  });

  it('shows the span when variants differ', () => {
    expect(variantPriceLabel(SHORT_PANTS, money)).toBe('Rs. 1200.00 – Rs. 4300.00');
  });

  it('never shows the parent 0.00 for a variant product', () => {
    // This is the defect itself, asserted directly: whatever the helper returns
    // for a variant product, it must not be the meaningless parent column.
    for (const p of [TIE, SHORT_PANTS]) {
      // Stated as "not what the old code produced" rather than as a literal, so
      // the assertion tracks the defect itself: `money(p.unitPrice)` IS the
      // expression the three screens used to render.
      expect(variantPriceLabel(p, money)).not.toBe(money(p.unitPrice));
      expect(variantPriceLabel(p, money)).not.toBe('Rs. 0.00');
    }
  });

  it('refuses to invent a figure when a bound is missing', () => {
    const malformed = product({ hasVariants: true, variantCount: 2, variantPriceMin: null });
    // Falling back to `unitPrice` here would re-introduce `Rs. 0.00`.
    expect(variantPriceLabel(malformed, money)).toBe('—');
  });

  it('uses the caller’s formatter, so each screen keeps its own currency', () => {
    const lkr = (n: number) => `LKR ${n.toFixed(2)}`;
    expect(variantPriceLabel(SHORT_PANTS, lkr)).toBe('LKR 1200.00 – LKR 4300.00');
    expect(variantPriceLabel(CEMENT, lkr)).toBe('LKR 2650.00');
  });
});

describe('variantSkuLabel', () => {
  it('keeps a legacy SKU, and the em dash for a legacy product without one', () => {
    expect(variantSkuLabel(CEMENT)).toBe('CEM-50');
    expect(variantSkuLabel(product({ sku: null }))).toBe('—');
  });

  it('names the variant count instead of an em dash', () => {
    // The parent `sku` is null on every one of these rows, so the old reading
    // told the operator nothing at all.
    expect(variantSkuLabel(TIE)).toBe('3 variants');
    expect(variantSkuLabel(SHORT_PANTS)).toBe('13 variants');
    expect(variantSkuLabel(product({ hasVariants: true, sku: null, variantCount: 1 }))).toBe(
      '1 variant',
    );
  });
});
