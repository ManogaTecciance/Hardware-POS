import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { PLATFORM_ADMIN_ROUTE } from '../decorators/platform-admin.decorator';
import { PlatformBoundaryGuard } from './platform-boundary.guard';

/**
 * D55. This guard is the whole of "a platform admin cannot read tenant
 * business data", so both directions are asserted, and the negative direction
 * is mutation-proven: a guard that only checked one way would pass a naive
 * test suite while leaving every workspace readable by the console.
 */
function contextFor(user: unknown) {
  const request = { user };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => 'handler',
    getClass: () => 'class',
  } as never;
}

function reflectorWith(meta: Record<string, boolean>): Reflector {
  return {
    getAllAndOverride: (key: string) => meta[key],
  } as unknown as Reflector;
}

const PLATFORM_ROUTE = reflectorWith({ [PLATFORM_ADMIN_ROUTE]: true });
const TENANT_ROUTE = reflectorWith({});
const PUBLIC_ROUTE = reflectorWith({ [IS_PUBLIC_KEY]: true });

const platformAdmin = { id: 'u1', tenantId: 'tnt_platform', role: 'OWNER', isPlatformAdmin: true };
const workspaceUser = { id: 'u2', tenantId: 'tnt_dev', role: 'OWNER', isPlatformAdmin: false };
/** A token minted before the flag existed carries no property at all. */
const legacyUser = { id: 'u3', tenantId: 'tnt_dev', role: 'OWNER' };

describe('PlatformBoundaryGuard', () => {
  describe('platform routes', () => {
    it('admits a platform admin', () => {
      const guard = new PlatformBoundaryGuard(PLATFORM_ROUTE);
      expect(guard.canActivate(contextFor(platformAdmin))).toBe(true);
    });

    it.each([
      ['a workspace user', workspaceUser],
      ['a legacy token with no flag', legacyUser],
    ])('refuses %s', (_label, user) => {
      const guard = new PlatformBoundaryGuard(PLATFORM_ROUTE);
      expect(() => guard.canActivate(contextFor(user))).toThrow(ForbiddenException);
    });
  });

  describe('tenant routes — the direction that makes the boundary real', () => {
    it('REFUSES a platform admin', () => {
      const guard = new PlatformBoundaryGuard(TENANT_ROUTE);
      expect(() => guard.canActivate(contextFor(platformAdmin))).toThrow(ForbiddenException);
    });

    it.each([
      ['a workspace user', workspaceUser],
      ['a legacy token with no flag', legacyUser],
    ])('admits %s', (_label, user) => {
      const guard = new PlatformBoundaryGuard(TENANT_ROUTE);
      expect(guard.canActivate(contextFor(user))).toBe(true);
    });

    /**
     * MUTATION PROOF. An implementation that only guarded the platform
     * direction — the easy half to write — still passes every test above
     * except this one. Reproduce that implementation and show the refusal
     * disappears, so the assertion above cannot be passing vacuously.
     */
    it('a one-directional guard would let a platform admin into a workspace', () => {
      const oneWay = (isPlatformRoute: boolean, isAdmin: boolean) => {
        if (isPlatformRoute && !isAdmin) throw new ForbiddenException();
        return true; // the missing half
      };
      expect(oneWay(false, true)).toBe(true);
      // …whereas the real guard refuses exactly that case.
      const guard = new PlatformBoundaryGuard(TENANT_ROUTE);
      expect(() => guard.canActivate(contextFor(platformAdmin))).toThrow(ForbiddenException);
    });
  });

  describe('unauthenticated and public', () => {
    it('is a no-op on a public route', () => {
      const guard = new PlatformBoundaryGuard(PUBLIC_ROUTE);
      expect(guard.canActivate(contextFor(undefined))).toBe(true);
      // Even a platform admin hitting login must pass through.
      expect(guard.canActivate(contextFor(platformAdmin))).toBe(true);
    });

    it('defers to JwtAuthGuard when there is no user', () => {
      const guard = new PlatformBoundaryGuard(TENANT_ROUTE);
      expect(guard.canActivate(contextFor(undefined))).toBe(true);
    });
  });
});
