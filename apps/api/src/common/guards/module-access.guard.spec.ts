import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ModuleKey } from '@hardware-pos/database';

import { ModuleAccessGuard } from './module-access.guard';
import { BusinessProfileService } from '../../modules/platform/business-profile.service';

/**
 * The guard's contract, in isolation from HTTP and the database.
 *
 * The point of these tests is the *deny* direction. A permissions guard that
 * wrongly allows is a bug; a module guard that wrongly allows is a tenant paying
 * for one product and using another, so every failure mode is asserted to deny
 * rather than merely "not crash".
 *
 * `platform-module-gating.spec.ts` covers the same guard over real HTTP against a
 * real database; this covers the branches that are awkward to provoke through the
 * wire (unknown enum member, lookup throwing).
 */
describe('ModuleAccessGuard', () => {
  function context(user: { tenantId: string } | undefined): ExecutionContext {
    return {
      getHandler: () => function handler() {},
      getClass: () => class Controller {},
      switchToHttp: () => ({ getRequest: () => ({ user, headers: {} }) }),
    } as unknown as ExecutionContext;
  }

  function build(options: {
    required: ModuleKey | undefined;
    isModuleEnabled?: jest.Mock;
  }): { guard: ModuleAccessGuard; isModuleEnabled: jest.Mock } {
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(options.required),
    } as unknown as Reflector;
    const isModuleEnabled = options.isModuleEnabled ?? jest.fn().mockResolvedValue(true);
    const service = { isModuleEnabled } as unknown as BusinessProfileService;
    return { guard: new ModuleAccessGuard(reflector, service), isModuleEnabled };
  }

  describe('routes without @RequireModule', () => {
    it('allows, and never touches the profile — every existing route is unaffected', async () => {
      const { guard, isModuleEnabled } = build({ required: undefined });

      await expect(guard.canActivate(context({ tenantId: 'tnt_a' }))).resolves.toBe(true);
      expect(isModuleEnabled).not.toHaveBeenCalled();
    });

    it('allows even with no authenticated user (a @Public() route)', async () => {
      const { guard } = build({ required: undefined });
      await expect(guard.canActivate(context(undefined))).resolves.toBe(true);
    });
  });

  describe('an enabled module', () => {
    it('allows', async () => {
      const { guard } = build({ required: ModuleKey.DINING });
      await expect(guard.canActivate(context({ tenantId: 'tnt_a' }))).resolves.toBe(true);
    });

    it('asks about the AUTHENTICATED tenant, not anything the client sent', async () => {
      const { guard, isModuleEnabled } = build({ required: ModuleKey.DINING });
      await guard.canActivate(context({ tenantId: 'tnt_from_session' }));
      expect(isModuleEnabled).toHaveBeenCalledWith('tnt_from_session', ModuleKey.DINING);
    });
  });

  describe('a disabled module', () => {
    it('rejects with 403', async () => {
      const { guard } = build({
        required: ModuleKey.DINING,
        isModuleEnabled: jest.fn().mockResolvedValue(false),
      });
      await expect(guard.canActivate(context({ tenantId: 'tnt_a' }))).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('does not name the module in the error — a response must not leak the module set', async () => {
      const { guard } = build({
        required: ModuleKey.DINING,
        isModuleEnabled: jest.fn().mockResolvedValue(false),
      });
      await expect(guard.canActivate(context({ tenantId: 'tnt_a' }))).rejects.toThrow(
        'Feature not available',
      );
    });
  });

  describe('fails closed', () => {
    it('rejects an unknown module key rather than treating it as ungated', async () => {
      const { guard, isModuleEnabled } = build({
        required: 'NOT_A_REAL_MODULE' as ModuleKey,
      });

      await expect(guard.canActivate(context({ tenantId: 'tnt_a' }))).rejects.toThrow(
        ForbiddenException,
      );
      // Never even asked: an unknown key cannot be enabled.
      expect(isModuleEnabled).not.toHaveBeenCalled();
    });

    it('rejects when there is no authenticated tenant', async () => {
      const { guard, isModuleEnabled } = build({ required: ModuleKey.DINING });

      await expect(guard.canActivate(context(undefined))).rejects.toThrow(ForbiddenException);
      expect(isModuleEnabled).not.toHaveBeenCalled();
    });

    it('rejects when the profile lookup throws — a database blip must not open a route', async () => {
      const { guard } = build({
        required: ModuleKey.DINING,
        isModuleEnabled: jest.fn().mockRejectedValue(new Error('connection reset')),
      });
      await expect(guard.canActivate(context({ tenantId: 'tnt_a' }))).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('gives the same generic message for every denial reason', async () => {
      const cases = [
        build({ required: 'NOPE' as ModuleKey }),
        build({ required: ModuleKey.DINING, isModuleEnabled: jest.fn().mockResolvedValue(false) }),
        build({
          required: ModuleKey.DINING,
          isModuleEnabled: jest.fn().mockRejectedValue(new Error('boom')),
        }),
      ];

      for (const { guard } of cases) {
        await expect(guard.canActivate(context({ tenantId: 'tnt_a' }))).rejects.toThrow(
          'Feature not available',
        );
      }
    });
  });
});
