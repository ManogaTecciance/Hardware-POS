import { CanActivate, ExecutionContext, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ModuleKey } from '@hardware-pos/database';
import type { Request } from 'express';

import { REQUIRE_MODULE_KEY } from '../decorators/require-module.decorator';
import { AuthenticatedUser } from '../../modules/auth/auth.types';
import { ALL_MODULE_KEYS } from '../../modules/platform/platform.constants';
import { BusinessProfileService } from '../../modules/platform/business-profile.service';

/**
 * Enforces `@RequireModule(...)` route metadata against the authenticated
 * tenant's effective platform profile.
 *
 * Registered globally after `PermissionsGuard`, so by the time it runs the caller
 * is authenticated (`JwtAuthGuard`), holds the right role (`RolesGuard`), and
 * holds the right permission (`PermissionsGuard`). This guard answers only the
 * remaining question: is the feature switched on for this tenant at all.
 *
 * ## Fail closed
 *
 * Disabling a module is a revocation. Every failure mode therefore denies:
 *
 * - no `request.user` → 403 (the tenant cannot be established from a verified
 *   session, and the `x-tenant-id` header is client-supplied — trusting it here
 *   would let a caller name whichever tenant has the module enabled);
 * - an unrecognised module key in the metadata → 403 (a typo or a key deleted
 *   from the enum must not silently open a route);
 * - the profile lookup throws → 403.
 *
 * Only an explicit "this module is enabled for this tenant" allows the request.
 */
@Injectable()
export class ModuleAccessGuard implements CanActivate {
  private readonly logger = new Logger(ModuleAccessGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly businessProfile: BusinessProfileService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<ModuleKey>(REQUIRE_MODULE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required) {
      return true;
    }

    // A key that is not in the enum can never be enabled, so treating it as a
    // denial is both correct and the safe direction to be wrong in.
    if (!ALL_MODULE_KEYS.includes(required)) {
      this.logger.error(`Route requires unknown module '${String(required)}' — denying.`);
      throw new ForbiddenException('Feature not available');
    }

    const request = context.switchToHttp().getRequest<Request & { user?: AuthenticatedUser }>();
    const tenantId = request.user?.tenantId;
    if (!tenantId) {
      // Reached only if a route is both @Public() and @RequireModule(), which is a
      // wiring mistake: there is no trustworthy tenant to evaluate against.
      this.logger.error(
        `Route requires module ${required} but has no authenticated tenant — denying.`,
      );
      throw new ForbiddenException('Feature not available');
    }

    let enabled: boolean;
    try {
      enabled = await this.businessProfile.isModuleEnabled(tenantId, required);
    } catch (err) {
      this.logger.error(
        `Could not resolve module ${required} for tenant ${tenantId}; denying. ` +
          `${(err as Error).message}`,
      );
      throw new ForbiddenException('Feature not available');
    }

    if (!enabled) {
      // Deliberately generic and identical to every other denial above: the
      // response must not tell a caller which modules a tenant has bought.
      throw new ForbiddenException('Feature not available');
    }
    return true;
  }
}
