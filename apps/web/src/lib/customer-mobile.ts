/*
 * Mobile-number rules shared by every surface that captures a customer number
 * (the POS capture popup and the back-office customer form).
 *
 * Counted in DIGITS, not characters, so the separators the placeholder invites
 * ("+94 77 123 4567") do not eat the allowance. Nine is the shortest real
 * local number once a leading 0 is dropped; fifteen is the E.164 ceiling, so
 * an international number entered in full still fits. The server caps `mobile`
 * at 40 characters, which the 24-character input cap stays inside.
 */
export const MOBILE_MIN_DIGITS = 9;
export const MOBILE_MAX_DIGITS = 15;
export const MOBILE_MAX_CHARS = 24;

/**
 * Keep what a phone number is made of and drop the rest as it is typed.
 *
 * Filtering on entry rather than validating after the fact: `inputMode="tel"`
 * is only a soft-keyboard hint, so on a desktop till every letter went
 * straight through to the customer record. A cashier who pastes "077 123 4567
 * (home)" gets the number, not an error they have to go back and fix.
 *
 * `+` survives only in first position, where it means a country code; anywhere
 * else it is a typo.
 */
export function sanitizeMobile(raw: string): string {
  const kept = raw.replace(/[^\d+\s-]/g, '');
  const plus = kept.startsWith('+') ? '+' : '';
  return (plus + kept.replace(/\+/g, '')).slice(0, MOBILE_MAX_CHARS);
}

/** Just the digits, which is what the length rules are about. */
export function digitsOf(value: string): string {
  return value.replace(/\D/g, '');
}

/** The digit-count rule as one message, or null for an empty or valid value. */
export function mobileDigitsError(value: string): string | null {
  if (value.trim() === '') return null;
  const digits = digitsOf(value);
  if (digits.length < MOBILE_MIN_DIGITS)
    return `Mobile number needs at least ${MOBILE_MIN_DIGITS} digits.`;
  if (digits.length > MOBILE_MAX_DIGITS)
    return `Mobile number cannot be more than ${MOBILE_MAX_DIGITS} digits.`;
  return null;
}
