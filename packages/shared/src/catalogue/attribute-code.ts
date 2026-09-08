/**
 * D125 / D125a — the rules for an option library entry's `code` and `swatchHex`.
 *
 * These live in `@hardware-pos/shared` for one reason: the API validates them at
 * the DTO and the web form previews them live as the operator types. Phase 4
 * shipped the same defect three times (4.15, 4.21, 4.22) by keeping a rule in
 * one package and a caller in another, so a rule that crosses a package
 * boundary now goes here, where there is no second copy to forget.
 *
 * Nothing here is retail-specific. A code is a short, stable, human-readable
 * token that a generated SKU can carry — `BLK`, `XL`, `34`, `500ML` — and the
 * rules are the same whatever the business sells.
 */

/**
 * Codes are short on purpose. They are concatenated into a SKU (`5.3`), so a
 * long one makes an unreadable identifier rather than a helpful one.
 */
export const ATTRIBUTE_CODE_MAX_LENGTH = 12;

/**
 * Uppercase alphanumerics, single hyphens between groups.
 *
 * No leading, trailing or doubled hyphen: a SKU joins its segments with `-`,
 * so a code that already ends in one produces `SHIRT-001-BLK--M`, which reads
 * as a typo and sorts unpredictably.
 */
const CODE_SHAPE = /^[A-Z0-9]+(?:-[A-Z0-9]+)*$/;

/** `#RRGGBB`. Three-digit shorthand is deliberately not accepted — see below. */
const SWATCH_SHAPE = /^#[0-9A-F]{6}$/;

/**
 * Fold a human-typed value into the canonical code shape.
 *
 * Idempotent: `normaliseAttributeCode(normaliseAttributeCode(x))` is
 * `normaliseAttributeCode(x)` for every input, which matters because the value
 * is normalised at the DTO and again in the form preview, and the two must
 * agree on the first pass.
 *
 * The transformation is deliberately lossy in one direction only — it removes
 * characters a code may not contain, it never invents any. An input that
 * normalises to the empty string is invalid, not silently replaced.
 */
export function normaliseAttributeCode(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-') // any run of separators or punctuation → one hyphen
    .replace(/^-+|-+$/g, '') // no leading or trailing hyphen
    .slice(0, ATTRIBUTE_CODE_MAX_LENGTH)
    .replace(/-+$/g, ''); // the slice above can leave a trailing hyphen behind
}

/** True when `value` is already exactly what the database should store. */
export function isValidAttributeCode(value: string): boolean {
  return value.length > 0 && value.length <= ATTRIBUTE_CODE_MAX_LENGTH && CODE_SHAPE.test(value);
}

/**
 * The reason `value` is not a valid code, or `null` when it is.
 *
 * A message rather than a boolean because this one is shown to an operator who
 * has just typed something and needs to know what to change. "Invalid" on its
 * own is the `4.19` failure — correct behaviour, invisible cause.
 */
export function attributeCodeIssue(value: string): string | null {
  if (value.length === 0) return 'A code is required.';
  if (value.length > ATTRIBUTE_CODE_MAX_LENGTH) {
    return `A code may be at most ${ATTRIBUTE_CODE_MAX_LENGTH} characters.`;
  }
  if (!CODE_SHAPE.test(value)) {
    return 'A code may contain only A-Z, 0-9 and single hyphens between them.';
  }
  return null;
}

/**
 * A starting suggestion for a code, derived from the option's name.
 *
 * Only ever a suggestion. The operator owns the code, because only they know
 * that their `Black` should read `BLK` and their `Extra Large` should read
 * `XL`; guessing an abbreviation would produce a SKU nobody recognises and
 * would be impossible to change later without reprinting labels.
 */
export function suggestAttributeCode(name: string): string {
  return normaliseAttributeCode(name);
}

/**
 * Fold a typed colour into `#RRGGBB`, or `null` when it is not a colour at all.
 *
 * Accepts a missing `#` and any case, because both are what people type.
 * Rejects the three-digit shorthand (`#f00`) rather than expanding it: the
 * value is rendered as a swatch AND may be printed on a label, and silently
 * turning `#f00` into `#FF0000` is an assumption about the operator's intent
 * that is invisible once stored.
 */
export function normaliseSwatchHex(raw: string): string | null {
  const trimmed = raw.trim().toUpperCase();
  const candidate = trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
  return SWATCH_SHAPE.test(candidate) ? candidate : null;
}

/** True when `value` is already exactly what the database should store. */
export function isValidSwatchHex(value: string): boolean {
  return SWATCH_SHAPE.test(value);
}
