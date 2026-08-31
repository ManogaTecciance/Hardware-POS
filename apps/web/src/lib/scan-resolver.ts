import type { ClientProduct, ClientVariant } from './catalog';
import { scanCandidates } from './use-barcode-scanner';

/**
 * D99 (1c.5) — what a scanned or typed code resolves to.
 *
 * `variant` is null only for a legacy variant-less product, where the code
 * matched the product's own SKU. Every barcode match names a variant, because
 * `Product` has no barcode column: D44 gives one to `ProductVariant` alone, and
 * says the parent-level SKU "is not read" once a product has variants. Scanning
 * is therefore inherently a variant-level operation in this data model.
 */
export interface ScanHit {
  product: ClientProduct;
  variant: ClientVariant | null;
}

/**
 * Resolve a scanned or typed code against the whole loaded catalogue.
 *
 * Searches every product, not the filtered page — a scan must work regardless of
 * which category tab or search term is active, which is the rule the previous
 * `findBySku` established and this keeps.
 *
 * ## Precedence, and why it is in this order
 *
 *   1. **variant barcode** — what a scanner actually emits
 *   2. **variant SKU** — what a cashier types when a barcode is damaged, and
 *      what is printed on a shelf label
 *   3. **product SKU** — legacy variant-less products only; the server sends
 *      null for a variant product precisely so it cannot be matched here
 *
 * A contrived collision (one variant's SKU equal to another's barcode) resolves
 * deterministically rather than by chance, which is the point of fixing an order
 * rather than searching a merged set.
 *
 * Each candidate is tried through the whole ladder before the next: a QR payload
 * that unwraps to two possible codes should resolve the first one completely,
 * not match the second candidate's barcode ahead of the first candidate's SKU.
 *
 * Pure and exported for testing — the precedence *is* the behaviour, and proving
 * it as a function is exhaustive in a way a simulated scanner is not.
 */
export function resolveScan(products: ClientProduct[], code: string): ScanHit | null {
  for (const candidate of scanCandidates(code)) {
    const key = candidate.trim().toLowerCase();
    if (!key) continue;

    for (const product of products) {
      for (const variant of product.variants) {
        if ((variant.barcode ?? '').trim().toLowerCase() === key) {
          return { product, variant };
        }
      }
    }

    for (const product of products) {
      for (const variant of product.variants) {
        if (variant.sku.trim().toLowerCase() === key) {
          return { product, variant };
        }
      }
    }

    for (const product of products) {
      if ((product.sku ?? '').trim().toLowerCase() === key) {
        return { product, variant: null };
      }
    }
  }
  return null;
}
