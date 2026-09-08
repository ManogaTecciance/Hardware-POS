import { Body, Controller, Get, Param, Put } from '@nestjs/common';
import { ModuleKey } from '@hardware-pos/database';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequireModule } from '../../common/decorators/require-module.decorator';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AuthenticatedUser } from '../auth/auth.types';
import { Permission } from '../auth/permissions';
import { UpdateOpeningHoursDto } from './dto/opening-hours.dto';
import { OpeningHoursService, OpeningHoursView } from './opening-hours.service';
import { UpdateRestaurantBranchConfigDto } from './dto/restaurant-config.dto';
import {
  RestaurantBranchConfigView,
  RestaurantConfigService,
} from './restaurant-config.service';

// Phase 2A. Gated on `DINING` because restaurant configuration is meaningless
// for a hardware tenant — the module set for RESTAURANT/CAFE/BAKERY enables
// it, and a Tile Shop tenant is refused server-side.
@Controller('restaurant/branches')
@RequireModule(ModuleKey.DINING)
export class RestaurantConfigController {
  constructor(
    private readonly service: RestaurantConfigService,
    private readonly openingHours: OpeningHoursService,
    private readonly audit: AuditLogService,
  ) {}

  @Get(':branchId/config')
  @RequirePermissions(Permission.PLATFORM_PROFILE_READ)
  get(
    @TenantId() tenantId: string,
    @Param('branchId') branchId: string,
  ): Promise<RestaurantBranchConfigView> {
    return this.service.get(tenantId, branchId);
  }

  @Put(':branchId/config')
  @RequirePermissions(Permission.RESTAURANT_CONFIG_MANAGE)
  async update(
    @TenantId() tenantId: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Param('branchId') branchId: string,
    @Body() dto: UpdateRestaurantBranchConfigDto,
  ): Promise<RestaurantBranchConfigView> {
    const before = await this.service.get(tenantId, branchId);
    const after = await this.service.update(tenantId, branchId, dto);
    await this.audit.record(tenantId, {
      userId: actor.id,
      action: 'RESTAURANT_CONFIG_UPDATED',
      entityType: 'RestaurantBranchConfig',
      entityId: branchId,
      metadata: {
        branchId,
        before: {
          serviceChargePercent: before.serviceChargePercent,
          takeawayEnabled: before.takeawayEnabled,
          dineInEnabled: before.dineInEnabled,
          defaultTicketTargetMinutes: before.defaultTicketTargetMinutes,
        },
        after: {
          serviceChargePercent: after.serviceChargePercent,
          takeawayEnabled: after.takeawayEnabled,
          dineInEnabled: after.dineInEnabled,
          defaultTicketTargetMinutes: after.defaultTicketTargetMinutes,
        },
      },
    });
    return after;
  }

  /*
   * D90 — opening hours.
   *
   * READ is gated on PLATFORM_PROFILE_READ, the same permission as the
   * config read above: the calendar is a floor tool, and the waiter reading
   * the book needs today's hours as much as the owner setting them. WRITE is
   * the owner's, like every other branch configuration.
   */
  @Get(':branchId/opening-hours')
  @RequirePermissions(Permission.PLATFORM_PROFILE_READ)
  getOpeningHours(
    @TenantId() tenantId: string,
    @Param('branchId') branchId: string,
  ): Promise<OpeningHoursView> {
    return this.openingHours.get(tenantId, branchId);
  }

  @Put(':branchId/opening-hours')
  @RequirePermissions(Permission.RESTAURANT_CONFIG_MANAGE)
  async updateOpeningHours(
    @TenantId() tenantId: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Param('branchId') branchId: string,
    @Body() dto: UpdateOpeningHoursDto,
  ): Promise<OpeningHoursView> {
    const before = await this.openingHours.get(tenantId, branchId);
    const after = await this.openingHours.replace(tenantId, branchId, dto);
    await this.audit.record(tenantId, {
      userId: actor.id,
      action: 'BRANCH_OPENING_HOURS_UPDATED',
      entityType: 'BranchOpeningHours',
      entityId: branchId,
      metadata: {
        branchId,
        // Serialised through JSON so the audit row carries plain values:
        // Prisma's InputJsonValue will not take a typed interface array.
        before: JSON.parse(JSON.stringify({ weekly: before.weekly, overrides: before.overrides })),
        after: JSON.parse(JSON.stringify({ weekly: after.weekly, overrides: after.overrides })),
      },
    });
    return after;
  }
}
