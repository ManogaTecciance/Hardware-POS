/**
 * Redact fields that must never appear in an audit record (Phase 1.5.7).
 *
 * The audit table is a permanent, cross-team readable record. Passwords, PINs,
 * tokens and credentials must not enter it — no matter which caller happens to
 * pass them, no matter how deeply nested the value is. This is the single
 * choke point, invoked once by `AuditLogService.record` so that a caller
 * shipping a raw request body cannot bypass it.
 *
 * Substitution, not deletion. The key stays visible with the sentinel
 * `[REDACTED]`, so a reviewer looking at the log knows the value was
 * *intentionally suppressed* rather than never present. That distinction
 * matters when reconstructing an incident — an absent key looks like a
 * missing field and rewards the wrong instinct.
 *
 * `MAX_DEPTH` is a defence-in-depth against a caller passing a self-cyclic
 * value; JSON serialisation would throw on cycles anyway, so this only
 * protects the walker itself. `MAX_LENGTH` prevents an enormous field from
 * blowing up the redactor.
 */

const REDACTED = '[REDACTED]';
const MAX_DEPTH = 12;
const MAX_STRING = 4096;

/**
 * Case-insensitive substring match against a curated list. `.includes` so
 * `x-authorization-token` matches, and camel/kebab variations are covered
 * by the shape of the key rather than a per-name entry.
 */
const FORBIDDEN_KEY_PATTERNS: readonly string[] = [
  'password',
  'passphrase',
  'pin',
  'pinhash',
  'passwordhash',
  'token',
  'accesstoken',
  'refreshtoken',
  'authorization',
  'cookie',
  'secret',
  'apikey',
  'api_key',
  'tokenencryptionkey',
  'clientsecret',
  'privatekey',
  'jwt',
  'sessionid',
  'credential',
  'credentials',
  'bearer',
];

function isForbiddenKey(key: string): boolean {
  const lower = key.toLowerCase();
  return FORBIDDEN_KEY_PATTERNS.some((pattern) => lower.includes(pattern));
}

function isPrimitive(value: unknown): value is string | number | boolean | null | undefined {
  const type = typeof value;
  return value === null || type === 'string' || type === 'number' || type === 'boolean' || type === 'undefined';
}

/**
 * Walk `value`, replacing every forbidden-key subtree with `[REDACTED]`.
 * Returns a fresh copy — the input is not mutated so a caller retains its
 * original structure for whatever else it needs it for.
 */
export function sanitizeAuditMetadata(value: unknown, depth = 0): unknown {
  if (depth >= MAX_DEPTH) {
    return REDACTED;
  }

  if (typeof value === 'string') {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  }

  if (isPrimitive(value)) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeAuditMetadata(item, depth + 1));
  }

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (isForbiddenKey(key)) {
        out[key] = REDACTED;
      } else {
        out[key] = sanitizeAuditMetadata(val, depth + 1);
      }
    }
    return out;
  }

  // Unknown shape (function, symbol, bigint). Coerce to a safe stringified
  // marker — the audit table takes JSON only.
  return String(value);
}

export const AUDIT_REDACTED_SENTINEL = REDACTED;
export const AUDIT_FORBIDDEN_KEY_PATTERNS = FORBIDDEN_KEY_PATTERNS;
