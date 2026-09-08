import { SetMetadata } from '@nestjs/common';

export const PLATFORM_ADMIN_ROUTE = 'axlopos:platform-admin-route';

/**
 * D55 — marks a route as belonging to the platform console.
 *
 * `PlatformBoundaryGuard` reads this in BOTH directions: a tenant user cannot
 * reach a marked route, and a platform admin cannot reach an unmarked one. The
 * second half is what makes "platform admins never read tenant business data"
 * a property of the guard rather than of the endpoints someone remembered to
 * check.
 */
export const PlatformAdminRoute = () => SetMetadata(PLATFORM_ADMIN_ROUTE, true);
