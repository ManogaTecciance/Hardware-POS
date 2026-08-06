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

/**
 * The tenant this device belongs to (Slice 8.8).
 *
 * ## Why the device has to remember it
 *
 * PIN sign-in is pre-auth: there is no session to derive a tenant from, so the
 * terminal states its own in `x-tenant-id`. Until this slice that value was the
 * literal `'tnt_dev'` — correct on exactly one seeded database and wrong for every
 * real deployment, which is a hard-coded single-tenant assumption sitting in the
 * authentication path of a platform whose whole point is many tenants.
 *
 * A POS terminal is *commissioned*: someone signs in with an email and password
 * once, and cashiers use PINs from then on. That first sign-in is where the tenant
 * becomes known, so it is recorded here.
 *
 * ## What this is not
 *
 * Not a credential and not a trust decision. A tenant id names a workspace the way
 * the slug does; the PIN and its tenant are checked together by the server, so a
 * hand-edited value cannot authenticate anyone — it can only fail. It deliberately
 * outlives sign-out, because "cashier signs out, next cashier signs in with a PIN"
 * is the flow the terminal exists for.
 */
const TENANT_KEY = 'axlopos.tenant';
/** Prisma cuids in practice; bounded and character-checked so junk never leaves. */
const TENANT_ID = /^[a-z0-9_-]+$/i;

export function rememberTenant(tenantId: string): void {
  const trimmed = tenantId.trim();
  try {
    if (trimmed && TENANT_ID.test(trimmed) && trimmed.length <= MAX_LENGTH) {
      window.localStorage.setItem(TENANT_KEY, trimmed);
    }
    // A malformed id is ignored rather than cleared: the stored value came from a
    // successful sign-in, and discarding it would strand the terminal's PIN login.
  } catch {
    /* storage unavailable — PIN sign-in asks for an email sign-in instead */
  }
}

export function recallTenant(): string {
  try {
    const stored = window.localStorage.getItem(TENANT_KEY) ?? '';
    return TENANT_ID.test(stored) && stored.length <= MAX_LENGTH ? stored : '';
  } catch {
    return '';
  }
}
