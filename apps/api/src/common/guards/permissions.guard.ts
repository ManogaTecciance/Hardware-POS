import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import { PERMISSIONS_KEY } from '../decorators/permissions.decorator';
import { AuthenticatedUser } from '../../modules/auth/auth.types';
import { Permission } from '../../modules/auth/permissions';
import {
  PermissionResolver,
  type AuthoritySource,
} from '../../modules/auth/permission-resolver.service';

/** The resolved authority, attached to the request for audit and diagnostics. */
export interface RequestAuthority {
  source: AuthoritySource;
  reason?: string;
}

/**
 * Enforces `@RequirePermissions(...)` route metadata. No metadata → allowed.
 *
 * Since Phase 1.5.4 the permission set comes from `PermissionResolver` — the
 * tenant's own role rows where the user has been migrated, the legacy
 * `ROLE_PERMISSIONS` map where they have not. The guard makes no policy decision
 * about which; it asks, and refuses if the answer does not cover the route.
 *
 * Behaviour is unchanged for every existing user: one with no `roleId` resolves
 * through the legacy authority, and the seeded roles are proven equal to it by
 * `role-templates.parity.spec.ts` and `role-seeding.spec.ts`.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly resolver: PermissionResolver,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<Permission[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) {
      return true;
    }

    const request = context
      .switchToHttp()
      .getRequest<Request & { user?: AuthenticatedUser; authority?: RequestAuthority }>();
    const user = request.user;
    if (!user) {
      throw new ForbiddenException('Not authenticated');
    }

    const authority = await this.resolver.resolve(user);
    // Recorded on the request rather than logged per call: the audit expansion in
    // 1.5.7 needs to say which authority made a decision, and the migration report
    // needs to count how many users still take the legacy path.
    request.authority = { source: authority.source, reason: authority.reason };

    const allowed = required.every((permission) => authority.permissions.has(permission));
    if (!allowed) {
      // Deliberately the same message whatever the reason. "Your role is broken"
      // and "you lack this permission" are different facts, and only one of them
      // is the caller's business.
      throw new ForbiddenException('Insufficient permissions');
    }
    return true;
  }
}
