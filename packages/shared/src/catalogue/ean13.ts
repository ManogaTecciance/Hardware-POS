/**
 * D125 Part 3 — EAN-13, and why 18 of the 20 pilot barcodes are invalid
 * (Phase 5, steps `5.5` and `5.9`).
 *
 * The investigation that produced D125 measured every barcode in the pilot
 * database and found two generators in play (`2001…` and `2990…`), NEITHER of
 * which computes a check digit. The two that pass do so by coincidence — a
 * sequential counter lands on the right digit about one time in ten.
 *
 * Nothing looks wrong until a label is rendered, because the prefix is correct:
 * `2` is the GS1 range reserved for in-store use. But an EAN-13 symbol cannot
 * be produced from an invalid payload, so `5.7` would have failed on 18 of 20
 * rows and the cause would have read as a rendering bug.
 *
 * Pure, and shared, because three callers need the identical rule: allocation
 * (`5.5`), the DTO that validates a typed barcode, and the reissue pass (`5.9`).
 */

/** An EAN-13 is exactly 13 digits: 12 of payload and one check digit. */
export const EAN13_LENGTH = 13;

/** The payload the check digit is computed over. */
export const EAN13_PAYLOAD_LENGTH = 12;

/**
 * Compute the check digit for a 12-digit payload.
 *
 * Weights alternate 1,3,1,3… from the LEFT across the 12 payload digits; the
 * check digit is whatever makes the weighted sum a multiple of ten.
 *
 * Throws on anything that is not 12 digits rather than returning a number for
 * an input it cannot have computed correctly — a wrong check digit is exactly
 * the failure this module exists to prevent, and returning one silently would
 * reproduce it.
 */
export function ean13CheckDigit(payload: string): number {
  if (!new RegExp(`^\\d{${EAN13_PAYLOAD_LENGTH}}$`).test(payload)) {
    throw new Error(`EAN-13 payload must be exactly ${EAN13_PAYLOAD_LENGTH} digits`);
  }
  let sum = 0;
  for (let i = 0; i < EAN13_PAYLOAD_LENGTH; i += 1) {
    const digit = payload.charCodeAt(i) - 48;
    sum += i % 2 === 0 ? digit : digit * 3;
  }
  return (10 - (sum % 10)) % 10;
}

/** The full 13-digit code for a 12-digit payload. */
export function withEan13CheckDigit(payload: string): string {
  return `${payload}${ean13CheckDigit(payload)}`;
}

/**
 * True when `value` is shaped like an EAN-13 — 13 digits, nothing else.
 *
 * Deliberately separate from validity. The two questions are different, and the
 * DTO rule keys on SHAPE: a supplier's CODE128 alphanumeric is not an EAN-13
 * and must be accepted as-is, while a 13-digit numeric string is claiming to be
 * one and must therefore carry a correct check digit.
 */
export function looksLikeEan13(value: string): boolean {
  return new RegExp(`^\\d{${EAN13_LENGTH}}$`).test(value);
}

/** True when `value` is 13 digits AND its final digit is the correct one. */
export function isValidEan13(value: string): boolean {
  if (!looksLikeEan13(value)) return false;
  const payload = value.slice(0, EAN13_PAYLOAD_LENGTH);
  const check = value.charCodeAt(EAN13_PAYLOAD_LENGTH) - 48;
  return ean13CheckDigit(payload) === check;
}

/**
 * GS1 reserves prefixes beginning `02` and `20`–`29` for a shop's own use.
 *
 * A code in this range is guaranteed never to collide with a manufacturer's
 * real barcode, which is the property that makes shop-generated codes safe.
 * The pilot's `2001…` and `2990…` are both correctly inside it — the prefix was
 * never the problem.
 */
export function isInStoreEan13Prefix(prefix: string): boolean {
  if (!/^\d{2,6}$/.test(prefix)) return false;
  return prefix.startsWith('02') || /^2[0-9]/.test(prefix);
}

/**
 * The reason `prefix` cannot be used, or `null` when it can.
 *
 * A message rather than a boolean: this is configured once during workspace
 * setup, and getting it wrong means reprinting every label the shop ever
 * produces, so the refusal has to say what is wrong with it.
 */
export function ean13PrefixIssue(prefix: string): string | null {
  if (!/^\d+$/.test(prefix)) return 'A barcode prefix must be digits only.';
  if (prefix.length < 2 || prefix.length > 6) {
    return 'A barcode prefix must be between 2 and 6 digits.';
  }
  if (!isInStoreEan13Prefix(prefix)) {
    return 'A barcode prefix must start with 02 or 20-29 — the GS1 range reserved for in-store codes. Anything else can collide with a manufacturer barcode.';
  }
  return null;
}

/**
 * Compose an in-store EAN-13 from a prefix and an allocated number.
 *
 * The sequence fills the width between the prefix and the check digit, so a
 * four-digit prefix leaves eight digits — 100 million codes, which is not a
 * constraint any shop will meet.
 *
 * Returns `null` when the number no longer fits. That is a real end-of-range,
 * and truncating or wrapping would REISSUE a code that is already on a printed
 * label — the one outcome worse than refusing to allocate.
 */
export function composeInStoreEan13(prefix: string, sequence: number): string | null {
  const bodyWidth = EAN13_PAYLOAD_LENGTH - prefix.length;
  if (bodyWidth <= 0) return null;
  const body = String(sequence);
  if (body.length > bodyWidth) return null;
  return withEan13CheckDigit(`${prefix}${body.padStart(bodyWidth, '0')}`);
}
