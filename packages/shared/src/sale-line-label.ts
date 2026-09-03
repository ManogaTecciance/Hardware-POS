/**
 * How a sold line is named on a document (D99, 2.12).
 *
 * ## Why this lives in `shared` and not beside one renderer
 *
 * A sale line is rendered in **four** places, two per side:
 *
 * | | |
 * |---|---|
 * | `documents.service` | the A4 invoice the server renders |
 * | `receipts.service` | the 80mm thermal receipt the server renders |
 * | `sale-a4-document.tsx` | the A4 the web app renders itself |
 * | `receipt-print.ts` | the client fallback when the server render fails |
 *
 * 1c.7 put the variant on two of them and missed the other two, so the same
 * sale printed with the size from one endpoint and without it from another.
 * Four copies of a formatting rule is four chances to disagree, and the way it
 * was discovered — a customer-facing invoice — is the expensive way.
 *
 * So the rule lives here, in the one package both apps import. A fifth renderer
 * gets it by calling this; the enumerating test in `sale-line-label.spec` fails
 * if one is added that does not.
 *
 * ## The format
 *
 * `Cotton T-Shirt (M — Navy)` — PO, 2026-09-01.
 *
 * Variant names are stored slash-separated (`variantDisplayName` joins option
 * values with `/`, giving `M / Navy`), because that is the compact form the
 * till's picker wants in a narrow row. A document has room to be read aloud,
 * and the PO asked for a hyphen. Converting here rather than changing the
 * stored form keeps the snapshot intact: `variantNameSnapshot` is frozen at
 * sale time (D44) and must not be rewritten to suit a later presentation
 * choice.
 */

/** The separator `variantDisplayName` uses between option values. */
const STORED_SEPARATOR = ' / ';

/** What a document uses instead. An em dash, not a hyphen-minus. */
const DOCUMENT_SEPARATOR = ' — ';

/**
 * `Cotton T-Shirt (M — Navy)`, or just the product name when no variant was
 * sold.
 *
 * `variantName` is the D44 snapshot, not the live variant: renaming a size
 * later must not rewrite an old receipt.
 *
 * A blank or whitespace-only snapshot is treated as absent rather than printed
 * as empty parentheses — a line that read `Cotton T-Shirt ()` would look like a
 * bug to a customer holding the paper.
 */
export function saleLineLabel(
  productName: string,
  variantName: string | null | undefined,
): string {
  const variant = variantName?.trim();
  if (!variant) return productName;
  return `${productName} (${variant.split(STORED_SEPARATOR).join(DOCUMENT_SEPARATOR)})`;
}

/**
 * The promotion note printed beneath a sale line (D102, 4.6).
 *
 * A bill that shows a tie at 0.00 with no explanation reads as a pricing error;
 * naming the offer is what makes the zero legible, and it is what a customer
 * argues a return from. `promotionNameSnapshot` is frozen at sale time (D44), so
 * a reprint says what the customer was actually given even if the promotion has
 * since been renamed or deleted.
 *
 * Here for the same reason `saleLineLabel` is: four renderers print a sale line,
 * and `sale-line-renderers.spec` enumerates all four and fails if one skips it.
 *
 * Returns `null` when there is nothing to say, so a renderer's own falsy check
 * stays a single `?`.
 */
export function saleLinePromotionNote(
  promotionName: string | null | undefined,
): string | null {
  const name = promotionName?.trim();
  return name ? `Promotion: ${name}` : null;
}
