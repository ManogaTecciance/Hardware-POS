/**
 * D138 — deriving the stored key for a business detail from its label.
 *
 * ## Why the operator never types a key
 *
 * `Product.attributes` is a JSON document keyed by these strings, so a key is
 * an identity: reports address it, existing rows already carry it, and the
 * server refuses a value whose key the schema does not declare. That makes it
 * exactly the wrong thing to put in front of somebody who wants to add "Care
 * instructions" to a clothing catalogue. So the label is the only thing typed,
 * and the key is derived once, when the field is FIRST saved.
 *
 * ## Why it is derived once and never again
 *
 * Re-deriving on every save would turn a typo fix in a label into a silent
 * rename, which orphans every value already stored under the old key. A field
 * that came back from the server therefore keeps the key the server sent, and
 * only a field the operator has just added has one derived for it. That is the
 * whole reason a draft distinguishes `key: null` from `key: 'material'`.
 */

/** The server's rule, restated so a bad key is caught before the round trip. */
export const BUSINESS_DETAIL_KEY_PATTERN = /^[a-z][a-zA-Z0-9]*$/;

/**
 * `"Care instructions"` → `"careInstructions"`.
 *
 * Non-alphanumerics are separators, not characters: `"Size (cm)"` gives
 * `"sizeCm"`. A label that yields nothing usable — empty, punctuation only, or
 * one starting with a digit, none of which the pattern admits — is prefixed
 * rather than rejected, because refusing to name a field the operator can see
 * on screen is a worse answer than naming it `field2026Season`.
 */
export function keyFromLabel(label: string): string {
  const words = label.split(/[^a-zA-Z0-9]+/).filter(Boolean);
  const camel = words
    .map((w, i) =>
      i === 0 ? w.charAt(0).toLowerCase() + w.slice(1) : w.charAt(0).toUpperCase() + w.slice(1),
    )
    .join('');
  if (BUSINESS_DETAIL_KEY_PATTERN.test(camel)) return camel;
  return `field${camel.charAt(0).toUpperCase()}${camel.slice(1)}`;
}

/**
 * …made unique against the keys already in the list.
 *
 * Two fields cannot share a key — one value per product per key is the whole
 * storage model — and the server refuses a duplicate outright. Two labels that
 * collapse to the same key ("Care instructions" and "Care Instructions") are an
 * ordinary thing to type, so the collision is resolved here rather than sent.
 */
export function uniqueKeyFromLabel(label: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base = keyFromLabel(label);
  if (!used.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}${n}`;
    if (!used.has(candidate)) return candidate;
  }
}
