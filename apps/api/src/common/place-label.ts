/**
 * D104 — one arrangement, several parties, and a ticket that says which.
 *
 * Before D104 a table carried at most one live tab, so the table's own name was
 * a complete answer to "who is this for". Now two parties can share one open
 * table, and without the tab's name the kitchen prints two identical tickets
 * and the pass has no way to tell whose food is whose.
 *
 * This deliberately does NOT compose the base label. The kitchen names a table
 * by `code · area`, the unified order list by `label ?? code`, and those two
 * conventions predate this record and are asserted by their own tests — folding
 * them together here would be a behaviour change smuggled in under a naming
 * helper. Each caller keeps its own label and passes it through.
 */
export function withTabName(placeLabel: string | null, tabName: string | null): string | null {
  if (!placeLabel) return placeLabel;
  const tab = tabName?.trim();
  return tab ? `${placeLabel} · ${tab}` : placeLabel;
}
