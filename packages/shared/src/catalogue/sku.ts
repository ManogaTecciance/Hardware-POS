/**
 * D125 — SKU composition (Phase 5, step `5.3`).
 *
 * `<CATEGORY>-<SEQ>[-<OPTION CODE>…]` — for example `APPAREL-0007-BLK-M`.
 *
 * Pure and side-effect free on purpose: the number comes from the caller,
 * because allocating it is a transactional concern (`DocumentSequence`) and
 * composing it is not. That split is what lets the composition be tested
 * exhaustively without a database, and lets the allocator be tested for
 * concurrency without caring what the string looks like.
 */

import { normaliseAttributeCode } from './attribute-code.js';

/**
 * The category segment is capped shorter than a full code.
 *
 * A SKU is read aloud, written on a label and typed into a search box. The
 * category is the least informative part of it — the sequence identifies the
 * product and the option codes identify the variant — so it gets the smallest
 * share of the width.
 */
export const SKU_CATEGORY_SEGMENT_MAX = 8;

/** Sequence width. Four digits covers 9,999 products before it widens. */
export const SKU_SEQUENCE_PAD = 4;

/** Used when a product has no category at all. */
export const SKU_DEFAULT_CATEGORY_SEGMENT = 'GEN';

/**
 * Fold a category name into its SKU segment.
 *
 * Derived from the name rather than stored in a column, deliberately: a `code`
 * on `ProductCategory` would be a migration, a decision record and a field for
 * an operator to fill in before they can create their first product. The cost
 * of deriving is that renaming a category changes the segment for FUTURE SKUs
 * only — every SKU already issued is a stored string on the variant and is
 * untouched. That is the right trade: a SKU is an identifier, and identifiers
 * that change retroactively are the actual hazard.
 */
export function skuCategorySegment(categoryName: string | null | undefined): string {
  if (!categoryName) return SKU_DEFAULT_CATEGORY_SEGMENT;
  const normalised = normaliseAttributeCode(categoryName).slice(0, SKU_CATEGORY_SEGMENT_MAX);
  const trimmed = normalised.replace(/-+$/g, '');
  return trimmed === '' ? SKU_DEFAULT_CATEGORY_SEGMENT : trimmed;
}

export interface SkuParts {
  /** Already folded by `skuCategorySegment`. */
  categorySegment: string;
  /** The allocated per-tenant number. */
  sequence: number;
  /** Resolved option codes, in the product's dimension order. */
  optionCodes: readonly string[];
}

/**
 * Compose the identifier.
 *
 * Option codes are joined in the order given, which is the product's dimension
 * order — so `Size` before `Colour` on one product and the reverse on another
 * produce different-looking SKUs, and that is correct: the order is a property
 * of the product, and re-sorting it here would make the SKU disagree with the
 * variant matrix the operator is looking at.
 */
export function composeSku(parts: SkuParts): string {
  const sequence = String(parts.sequence).padStart(SKU_SEQUENCE_PAD, '0');
  return [parts.categorySegment, sequence, ...parts.optionCodes].join('-');
}
