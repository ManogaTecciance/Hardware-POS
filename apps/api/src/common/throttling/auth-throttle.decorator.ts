import { SetMetadata } from '@nestjs/common';

/**
 * Which throttling policy a route uses.
 *
 * A closed union rather than a free string, so the interceptor's `switch` is
 * exhaustive and a typo is a compile error instead of a route that silently
 * carries no limit at all.
 */
export type AuthThrottlePolicy = 'email-login' | 'refresh';

export const AUTH_THROTTLE_KEY = 'auth:throttle:policy';

/**
 * Mark an authentication route as rate-limited.
 *
 * Opt-in per route. That is a real risk — a new auth route added without this
 * decorator is unmetered — so `auth-throttle.coverage.spec.ts` asserts the exact
 * set of decorated routes and fails when an undecorated credential-accepting route
 * appears. Coverage is enforced by a test rather than trusted to review.
 */
export const AuthThrottle = (policy: AuthThrottlePolicy) =>
  SetMetadata(AUTH_THROTTLE_KEY, policy);
