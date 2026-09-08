import { Body, Controller, Get, Patch } from '@nestjs/common';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AuthenticatedUser } from '../auth/auth.types';
import { Permission } from '../auth/permissions';
import { BusinessProfileService } from './business-profile.service';
import { UpdateBusinessProfileDto } from './dto/update-business-profile.dto';
import { EffectiveBusinessProfile, ModuleState } from './platform.types';

/**
 * Read and manage one tenant's platform configuration.
 *
 * The tenant is always the authenticated caller's own: `@TenantId()` resolves it
 * from the verified session, and no route accepts a tenant id as a parameter,
 * query string, or body field. Tenant A therefore has no request it can construct
 * that reads or writes tenant B's profile.
 *
 * This is not global super-admin functionality — there is no cross-tenant listing
 * and no tenant-selection parameter anywhere in this controller.
 */
@Controller('platform')
export class PlatformController {
  constructor(
    private readonly businessProfile: BusinessProfileService,
    private readonly audit: AuditLogService,
  ) {}

  /**
   * The effective profile, with `source` distinguishing a stored configuration
   * (`EXPLICIT`) from the legacy Tile Shop compatibility default
   * (`LEGACY_DEFAULT`).
   *
   * Readable by every role: navigation depends on it, so a cashier that cannot
   * read its own tenant's module set could not render a POS screen.
   */
  @Get('profile')
  @RequirePermissions(Permission.PLATFORM_PROFILE_READ)
  getProfile(@TenantId() tenantId: string): Promise<EffectiveBusinessProfile> {
    return this.businessProfile.getEffectiveProfile(tenantId);
  }

  /** Per-module enablement, including modules explicitly turned off. */
  @Get('modules')
  @RequirePermissions(Permission.PLATFORM_PROFILE_READ)
  getModules(@TenantId() tenantId: string): Promise<ModuleState[]> {
    return this.businessProfile.getModuleStates(tenantId);
  }

  /**
   * Create or update the authenticated tenant's explicit profile.
   *
   * Restricted to `PLATFORM_PROFILE_MANAGE`, which only OWNER and ADMIN hold —
   * MANAGER, ACCOUNTANT, and CASHIER receive 403 from the global
   * `PermissionsGuard` before this handler runs.
   */
  @Patch('profile')
  @RequirePermissions(Permission.PLATFORM_PROFILE_MANAGE)
  async updateProfile(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateBusinessProfileDto,
  ): Promise<EffectiveBusinessProfile> {
    const next = await this.businessProfile.updateProfile(tenantId, dto);
    await this.audit.record(tenantId, {
      userId: user.id,
      action: 'platform_profile.updated',
      entityType: 'TenantBusinessProfile',
      entityId: tenantId,
      metadata: {
        businessType: next.businessType,
        inventoryMode: next.inventoryMode,
        accountingProvider: next.accountingProvider,
        enabledModules: next.enabledModules,
        version: next.version,
      },
    });
    return next;
  }
}
