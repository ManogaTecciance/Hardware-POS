/**
 * The storage abstraction behind authentication throttling (Slice 7.1).
 *
 * ## Why an abstraction rather than a library
 *
 * A rate limiter is only as correct as the counter it shares. AxloPOS has no
 * Redis and no distributed cache today (open decision O2), so the only
 * implementation that can ship now is process-local. That is genuinely useful —
 * it stops a single-replica deployment being brute-forced, which is the current
 * deployment — but it is **not** a multi-replica correctness model: with N
 * replicas behind a load balancer an attacker gets N times the budget.
 *
 * Rather than pretend otherwise, the policy is written against this interface and
 * the limitation is stated in one place ({@link RateLimitStore.isDistributed}) that
 * the health surface and the docs both read. Adding Redis later is a new
 * implementation of this interface and a provider swap — no policy change.
 *
 * The shape is deliberately the same one a Redis `INCR` + `EXPIRE` or a
 * `CL.THROTTLE` implements, so the obvious production adapter is a thin one.
 */

/** One counter bucket's verdict. */
export interface RateLimitDecision {
  /** Did this attempt fall within the allowance? */
  allowed: boolean;
  /** Attempts left in the current window once this one is counted. */
  remaining: number;
  /**
   * Whole seconds until the window resets. Always ≥ 1 when `allowed` is false, so
   * a `Retry-After: 0` can never be emitted (which clients read as "retry now").
   */
  retryAfterSeconds: number;
}

/** A named allowance: `limit` attempts per `windowMs`. */
export interface RateLimitRule {
  /** Stable identifier, used in the storage key and in logs. Never user data. */
  readonly name: string;
  readonly limit: number;
  readonly windowMs: number;
}

export const RATE_LIMIT_STORE = Symbol('RATE_LIMIT_STORE');

export interface RateLimitStore {
  /**
   * Count one attempt against `key` and report whether it is allowed.
   *
   * Must be atomic per key: two concurrent calls must not both read the same
   * pre-increment value. The in-memory implementation gets this from the single
   * threaded event loop; a Redis implementation gets it from `INCR`.
   */
  consume(key: string, rule: RateLimitRule): Promise<RateLimitDecision>;

  /**
   * Forget `key` entirely.
   *
   * Called after a *successful* authentication so a user who mistyped their
   * password four times and then got it right is not left one attempt from a
   * lockout. Without this the limiter would punish recovery, which is how rate
   * limiting turns into a self-inflicted denial of service.
   */
  reset(key: string): Promise<void>;

  /**
   * Whether this store is shared across API replicas.
   *
   * `false` means the limiter is best-effort per process and the deployment must
   * not claim multi-replica protection from it. Asserted by a test, surfaced in
   * the docs, and logged once at boot — a limitation that is only written down in
   * a comment is a limitation nobody knows about.
   */
  readonly isDistributed: boolean;

  /** Human-readable name for logs and the boot warning. */
  readonly description: string;
}
