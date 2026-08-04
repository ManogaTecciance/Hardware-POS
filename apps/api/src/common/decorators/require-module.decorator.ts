import { SetMetadata } from '@nestjs/common';
import { ModuleKey } from '@hardware-pos/database';

export const REQUIRE_MODULE_KEY = 'requireModule';

/**
 * Require a feature module to be enabled for the authenticated tenant, enforced
 * by `ModuleAccessGuard`.
 *
 * Usable on a controller class or a single handler; handler metadata overrides the
 * class. A route with no `@RequireModule` is never gated, which is why adding the
 * guard globally changed nothing about existing routes.
 *
 * This is tenant configuration, not authorization by role — it composes with
 * `@RequirePermissions` rather than replacing it. A route that needs both keeps
 * both decorators.
 *
 * @example
 * ＠RequireModule(ModuleKey.DINING)
 * ＠Controller('dining')
 * export class DiningController {}
 */
export const RequireModule = (moduleKey: ModuleKey) => SetMetadata(REQUIRE_MODULE_KEY, moduleKey);
