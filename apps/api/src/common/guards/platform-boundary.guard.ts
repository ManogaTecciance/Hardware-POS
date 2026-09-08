import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { PLATFORM_ADMIN_ROUTE } from '../decorators/platform-admin.decorator';
import { AuthenticatedUser } from '../../modules/auth/auth.types';

/**
 * D55 — the boundary between the platform console and every workspace.
 *
 * Runs in both directions, deliberately:
 *
 *   platform route  + tenant user   → 403
 *   tenant route    + platform user → 403
 *
 * The second rule is the load-bearing one. A platform admin's token is refused
 * by every route in the product that is not explicitly part of the console, so
 * "platform admins cannot read tenant business data" holds for endpoints
 * written after this guard as well as before it — it is not a list of places
 * someone remembered to check.
 *
 * A platform admin does carry a `tenantId` (they live in the dedicated
 * `platform` tenant so the FK is satisfied and the whole auth stack is reused).
 * That tenant owns no business data, so even a bypass of this guard would not
 * hand them a workspace's rows — but the guard is what makes it a rule rather
 * than an accident of seeding.
 */
@Injectable()
export class PlatformBoundaryGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const isPlatformRoute =
      this.reflector.getAllAndOverride<boolean>(PLATFORM_ADMIN_ROUTE, [
        context.getHandler(),
        context.getClass(),
      ]) ?? false;

    const request = context.switchToHttp().getRequest<{ user?: AuthenticatedUser }>();
    const user = request.user;
    // No authenticated user here means JwtAuthGuard already rejected, or the
    // route is public and returned above. Nothing to decide.
    if (!user) return true;

    const isPlatformAdmin = user.isPlatformAdmin === true;

    if (isPlatformRoute && !isPlatformAdmin) {
      throw new ForbiddenException({
        code: 'PLATFORM_ROUTE_FORBIDDEN',
        message: 'This endpoint belongs to the platform console.',
      });
    }
    if (!isPlatformRoute && isPlatformAdmin) {
      throw new ForbiddenException({
        code: 'TENANT_ROUTE_FORBIDDEN',
        message:
          'A platform administrator cannot act inside a workspace. Sign in as a workspace user.',
      });
    }
    return true;
  }
}
