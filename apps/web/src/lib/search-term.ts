/**
 * The canonical form of a term typed into a search box.
 *
 * ## Why trimming the ends is not enough
 *
 * Every search this app sends is matched with `contains` on the server, so
 * whitespace is compared literally: `Fried   Rice` is a substring of nothing
 * and returns zero rows for an item that plainly exists, while `Fried Rice`
 * finds three. Two spaces are easy to produce on a tablet keyboard — and an
 * empty result set gives the operator no clue why.
 *
 * So runs of whitespace collapse to a single space, and the ends are trimmed.
 * Tabs and newlines collapse too, for a term pasted out of a spreadsheet.
 *
 * ## Where this belongs
 *
 * Applied where the raw keystrokes become a QUERY — the debounce — never to
 * the input's own value. The operator keeps seeing exactly what they typed;
 * only what is sent is normalised. A side effect worth having: two spellings
 * of one term produce one query key, so re-spacing a term issues no second
 * request.
 */

/**
 * Trim a typed term and collapse internal whitespace.
 *
 * Returns `''` for a missing or whitespace-only term, which callers must treat
 * as "no term" rather than "match everything".
 */
export function normalizeSearchTerm(term: string | null | undefined): string {
  return (term ?? '').trim().replace(/\s+/g, ' ');
}
