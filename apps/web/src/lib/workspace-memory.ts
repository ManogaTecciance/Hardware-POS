/**
 * Remembers the last workspace slug used on this device (Slice 8.2).
 *
 * A slug is a non-sensitive, user-typed identifier — the same thing that appears
 * in a bookmarked `?workspace=` link — so keeping it locally is a convenience, not
 * a credential store. Nothing else about the sign-in is retained: **no email, no
 * password, no token.**
 *
 * Every read is defensive. `localStorage` throws in private-browsing modes and when
 * storage is disabled by policy, and a login page that crashes because it could not
 * remember a convenience value would be a far worse failure than forgetting it.
 */

const KEY = 'axlopos.workspace';
const MAX_LENGTH = 64;
/** The same shape the API's `LoginDto` accepts, so a junk value never reaches it. */
const SLUG = /^[a-z0-9][a-z0-9-]*$/i;

export function rememberWorkspace(slug: string): void {
  const trimmed = slug.trim();
  try {
    if (trimmed && SLUG.test(trimmed) && trimmed.length <= MAX_LENGTH) {
      window.localStorage.setItem(KEY, trimmed);
    } else {
      window.localStorage.removeItem(KEY);
    }
  } catch {
    /* storage unavailable — the field simply starts empty next time */
  }
}

export function recallWorkspace(): string {
  try {
    const stored = window.localStorage.getItem(KEY) ?? '';
    // Re-validated on the way out: the value could have been hand-edited, and this
    // is prefilled into a field the user may submit without looking at it.
    return SLUG.test(stored) && stored.length <= MAX_LENGTH ? stored : '';
  } catch {
    return '';
  }
}

export function forgetWorkspace(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    /* nothing to do */
  }
}

