/**
 * D125 — resolving the code a product's variation option contributes to a SKU
 * (Phase 5, step `5.2`).
 *
 * Two sources, and the difference between them is the whole point of the
 * library:
 *
 *   LIBRARY — the option is mapped, so its code is the one an operator chose
 *             once and every product that adopts the scale shares. `Colour ::
 *             Black` and `Color :: Black` mapped to the same library option
 *             produce the same segment, which is what makes a SKU stable.
 *
 *   DERIVED — the option is not mapped, so the code is folded from its own
 *             name. Correct today and unstable tomorrow: rename the option and
 *             the segment changes, and two products spelling the same concept
 *             differently produce different segments.
 *
 * The fallback exists because the library is optional (D125 — the links are
 * nullable and stay that way). A product that never adopts it must still be
 * able to generate a SKU. But the caller is told which source it got, so a
 * screen can say "this segment will change if you rename the option" rather
 * than presenting a derived code as though it were a decision anyone made.
 */

import { normaliseAttributeCode } from './attribute-code.js';

export type OptionCodeSource = 'LIBRARY' | 'DERIVED';

export interface ResolvedOptionCode {
  code: string;
  source: OptionCodeSource;
}

/** The minimum an option must expose to be resolvable. */
export interface OptionCodeInput {
  /** The option's own name on the product, e.g. "Black". */
  name: string;
  /** The mapped library option's code, or `null` when unmapped. */
  libraryCode?: string | null;
}

/**
 * Resolve one option's SKU segment.
 *
 * Returns `null` when neither source yields a usable code — an unmapped option
 * whose name contains nothing a code may carry ("///"). `null` is a real
 * answer, not an error: the caller decides whether to refuse the SKU or drop
 * the segment, and inventing a placeholder here would put a character in a
 * printed identifier that nobody chose.
 */
export function resolveOptionCode(option: OptionCodeInput): ResolvedOptionCode | null {
  const libraryCode = option.libraryCode ?? null;
  if (libraryCode !== null && libraryCode !== '') {
    return { code: libraryCode, source: 'LIBRARY' };
  }
  const derived = normaliseAttributeCode(option.name);
  return derived === '' ? null : { code: derived, source: 'DERIVED' };
}

/**
 * Resolve a whole variant's segments, in the order given.
 *
 * Returns `null` if ANY option fails to resolve, rather than a partial list.
 * A SKU missing one of its axes is not a shorter SKU — it is a different
 * identifier that may collide with a real one: `SHIRT-001-BLK` meaning
 * "black, size unknown" would collide with a genuine one-axis product.
 */
export function resolveOptionCodes(
  options: readonly OptionCodeInput[],
): ResolvedOptionCode[] | null {
  const resolved: ResolvedOptionCode[] = [];
  for (const option of options) {
    const one = resolveOptionCode(option);
    if (one === null) return null;
    resolved.push(one);
  }
  return resolved;
}

/** True when every segment came from the library — i.e. the SKU is stable. */
export function isFullyMapped(resolved: readonly ResolvedOptionCode[]): boolean {
  return resolved.length > 0 && resolved.every((r) => r.source === 'LIBRARY');
}
