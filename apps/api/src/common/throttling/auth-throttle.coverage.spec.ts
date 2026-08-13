/**
 * Throttle coverage (Slice 7.1).
 *
 * `@AuthThrottle` is opt-in per route, which is a real hazard: a new
 * credential-accepting endpoint added without it ships completely unmetered, and
 * nothing at runtime would complain. This spec closes that gap by reading the
 * decorator metadata off the real controller rather than the source text — a
 * renamed decorator or a moved import cannot make it inspect nothing, because the
 * assertion is on the registered handlers themselves.
 *
 * Written to the D30 standard: the expectation is an exact route→policy map, and
 * the mutation proofs show the map can fail in both directions.
 */
import { AUTH_THROTTLE_KEY, AuthThrottlePolicy } from './auth-throttle.decorator';
import { AuthController } from '../../modules/auth/auth.controller';

/**
 * The sentinel for "this handler carries no throttle policy".
 *
 * A literal `undefined` cannot be used: Jest's `toEqual` treats a property whose
 * value is `undefined` as absent, so `{...map, newRoute: undefined}` deep-equals
 * `map`. The first version of this spec did exactly that, and its own mutation
 * proof caught it — the route→policy assertion would have passed unchanged when a
 * new *undecorated* endpoint appeared, which is the one regression this file
 * exists to catch. A string sentinel makes every handler a visible key.
 */
const NONE = 'none' as const;

/** Every handler on AuthController, with the throttle policy it carries. */
function policyByHandler(): Record<string, AuthThrottlePolicy | typeof NONE> {
  const proto = AuthController.prototype as unknown as Record<string, unknown>;
  const names = Object.getOwnPropertyNames(proto).filter(
    (name) => name !== 'constructor' && typeof proto[name] === 'function',
  );
  // A controller that somehow exposed no handlers would make every assertion
  // below vacuous, so that is a failure in its own right.
  expect(names.length).toBeGreaterThan(0);

  return Object.fromEntries(
    names.map((name) => [
      name,
      (Reflect.getMetadata(AUTH_THROTTLE_KEY, proto[name] as object) as
        | AuthThrottlePolicy
        | undefined) ?? NONE,
    ]),
  );
}

describe('7.1 — every credential-accepting auth route is throttled', () => {
  it('the route→policy map is exactly this', () => {
    // Exact map, not a count. `logout` and `me` carry no policy deliberately:
    // `logout` must keep working for an expired session (refusing it would strand
    // a user signed in), and `me` already requires a verified JWT, so there is no
    // credential to guess.
    expect(policyByHandler()).toEqual({
      login: 'email-login',
      refresh: 'refresh',
      logout: NONE,
      me: NONE,
      // Both Phase 1.5.6 admin routes: both are authenticated, both go through
      // `PermissionResolver`, neither takes a credential. No new throttle.
      listAccessibleBranches: NONE,
      switchActiveBranch: NONE,
    });
  });

  it('each credential route carries a policy, stated positively', () => {
    const policies = policyByHandler();
    expect(policies.login).toBe('email-login');
    expect(policies.refresh).toBe('refresh');
  });

  it('no two credential routes share a policy — each has its own allowance', () => {
    const used = ['login', 'refresh'].map((h) => policyByHandler()[h]);
    expect(new Set(used).size).toBe(used.length);
  });

  it('the metadata probe can see a policy — so a missing one is a real absence', () => {
    // POSITIVE CONTROL for the whole file. If `Reflect.getMetadata` returned
    // undefined for everything (wrong key, decorator not applied at build time,
    // emitDecoratorMetadata disabled), every "carries no policy" assertion would
    // pass while proving nothing.
    const found = Object.values(policyByHandler()).filter((p) => p !== NONE);
    expect(found.length).toBeGreaterThan(0);
  });

  it('a new undecorated auth route would be detected', () => {
    // Mutation proof: the exact regression — an endpoint added without a policy.
    const real = policyByHandler();
    const withNewRoute = { ...real, ssoCallback: NONE };
    expect(withNewRoute).not.toEqual(real);
    expect(() => expect(withNewRoute).toEqual(real)).toThrow();
  });

  it('a policy silently removed from an existing route would be detected', () => {
    const real = policyByHandler();
    const weakened = { ...real, login: NONE };
    expect(weakened).not.toEqual(real);
    expect(() => expect(weakened.login).toBe('email-login')).toThrow();
  });
});
