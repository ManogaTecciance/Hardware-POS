/**
 * Calendar-day helpers shared by every `<input type="date">` in the app.
 *
 * Two things bite date inputs and are handled here once: they emit partial and
 * absurd values mid-typing (5–6-digit years), and "today" differs between the
 * server render and the browser, so it must never be computed during render.
 */

/**
 * A well-formed calendar day: strictly YYYY-MM-DD with a 4-digit year. Date
 * inputs happily emit 5–6-digit years mid-typing, which produce absurd
 * timestamps the API (rightly) rejects — treat those as "not set".
 */
export function isValidYmd(v: string | undefined): v is string {
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  return !Number.isNaN(Date.parse(`${v}T00:00:00`));
}

/**
 * Today as `YYYY-MM-DD` in the viewer's own timezone.
 *
 * Deliberately not `toISOString().slice(0, 10)`, which reports the UTC day and
 * so names tomorrow for anyone east of Greenwich late in the evening.
 *
 * Client-only: calling this during render would disagree with the server's day
 * and trip a hydration mismatch. Call it from an effect.
 */
export function todayIso(): string {
  const d = new Date();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

/**
 * How a sale's timestamp reads in a "recent sales" list: the time alone for a
 * sale from today, or the day for anything older.
 *
 * Backdating makes the distinction matter — a bare "14:23" on a sale dated last
 * month reads as if it just happened.
 */
export function formatSaleStamp(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  // The year only earns its space once the sale is not from this one — without
  // it a sale backdated across new year reads identically to one from last year.
  return d.getFullYear() === now.getFullYear()
    ? d.toLocaleDateString([], { day: '2-digit', month: 'short' })
    : d.toLocaleDateString([], { day: '2-digit', month: 'short', year: 'numeric' });
}
