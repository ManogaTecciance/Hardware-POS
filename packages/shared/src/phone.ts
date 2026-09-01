/**
 * Phone-number matching for customer lookup.
 *
 * ## The problem this solves
 *
 * Customer phone numbers are stored exactly as the operator typed them, and
 * lookup was a plain substring match on that raw text. So the same human
 * number written two ways could not find itself: a customer saved as
 * `0771234567` was invisible to a search for `+94 77 123 4567` — the format
 * the POS placeholder itself invites. The cashier saw "not found" for a
 * customer who exists, and created a duplicate.
 *
 * ## The rule, and why it names no country
 *
 * Two things break a naive comparison:
 *
 *  1. **Separators.** `077 123 4567` and `0771234567` differ only in spacing.
 *  2. **The trunk prefix.** A number reached nationally carries a leading `0`
 *     that the international form replaces with a dialling code.
 *
 * So each side is reduced to digits with leading zeros removed, and two
 * numbers match when **either reduced form contains the other**. That handles
 * the dialling code without knowing what it is: the national number survives
 * inside the international one as a substring.
 *
 * ```
 * '0771234567'      -> '771234567'
 * '+94 77 123 4567' -> '94771234567'   contains '771234567'  ✓
 * '077'             -> '77'            contained in both     ✓
 * ```
 *
 * Containment in both directions is what makes it symmetric: it does not
 * matter which of the two records was saved in international format. And
 * because a partial entry is just a shorter key, the same rule serves the
 * cashier who is still typing.
 *
 * No country code, dialling plan or locale is assumed anywhere. The only
 * claim made is that a leading zero is a trunk prefix rather than part of the
 * subscriber number, which is true wherever a trunk prefix is used and
 * harmless where it is not.
 *
 * ## Mirrored in SQL
 *
 * `CustomersRepository` applies the same reduction inside Postgres, so the
 * rule works on rows already stored without rewriting them. The two
 * implementations have to agree: the integration spec drives the SQL with
 * every format this module's unit tests cover, so a change made to one and
 * not the other fails there.
 */

/**
 * The shortest reduced key worth matching a phone number on.
 *
 * Not a dialling rule — a noise floor. A single digit appears in nearly every
 * number in the book, so a search that short would return the whole customer
 * list under the guise of a phone match.
 *
 * Two, counted AFTER the trunk zero is removed, lines up with the three
 * characters the POS lookup already waits for before it searches at all:
 * `077` reduces to `77` and is a real start, `07` reduces to `7` and is not.
 */
export const PHONE_MIN_SEARCH_DIGITS = 2;

/**
 * Reduce a phone number — or a partial one being typed — to a comparable key:
 * digits only, without the leading zeros a trunk prefix contributes.
 *
 * Returns `''` when the input carries no digits, which callers must treat as
 * "not a phone term" rather than "match everything".
 */
export function phoneSearchKey(value: string | null | undefined): string {
  const digits = (value ?? '').replace(/\D/g, '');
  return digits.replace(/^0+/, '');
}

/**
 * Whether a search term carries enough digits to be matched as a phone number.
 *
 * `Nimal` has none and must never reach the phone clause; `07` reduces to a
 * single digit and sits below the noise floor.
 */
export function isPhoneSearchable(term: string | null | undefined): boolean {
  return phoneSearchKey(term).length >= PHONE_MIN_SEARCH_DIGITS;
}

/**
 * Whether two phone values refer to the same subscriber, as far as a customer
 * lookup is concerned.
 *
 * Exported for the unit tests and for any caller matching in memory; the
 * customer search does the same comparison in SQL so it can run over rows it
 * has not loaded.
 */
export function phoneMatches(stored: string | null | undefined, term: string | null | undefined): boolean {
  const a = phoneSearchKey(stored);
  const b = phoneSearchKey(term);
  if (a === '' || b === '') return false;
  return a.includes(b) || b.includes(a);
}
