import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ModuleKey } from '@hardware-pos/database';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequireModule } from '../../common/decorators/require-module.decorator';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AuthenticatedUser } from '../auth/auth.types';
import { Permission } from '../auth/permissions';
import { CreateKitchenStationDto, UpdateKitchenStationDto } from './dto/kitchen-station.dto';
import { KitchenStationView, KitchenStationsService } from './kitchen-stations.service';

// Phase 2A. Gated on `KITCHEN` — kitchen stations are the KOT routing target
// and only a restaurant needs them. A hardware tenant is refused server-side.
@Controller('restaurant/branches/:branchId/kitchen-stations')
@RequireModule(ModuleKey.KITCHEN)
export class KitchenStationsController {
  constructor(
    private readonly service: KitchenStationsService,
    private readonly audit: AuditLogService,
  ) {}

  @Get()
  @RequirePermissions(Permission.PLATFORM_PROFILE_READ)
  list(
    @TenantId() tenantId: string,
    @Param('branchId') branchId: string,
    @Query('includeArchived') includeArchived?: string,
  ): Promise<KitchenStationView[]> {
    return this.service.list(tenantId, branchId, includeArchived === 'true');
  }

  @Get(':stationId')
  @RequirePermissions(Permission.PLATFORM_PROFILE_READ)
  get(
    @TenantId() tenantId: string,
    @Param('branchId') branchId: string,
    @Param('stationId') stationId: string,
  ): Promise<KitchenStationView> {
    return this.service.get(tenantId, branchId, stationId);
  }

  @Post()
  @RequirePermissions(Permission.KITCHEN_STATION_MANAGE)
  async create(
    @TenantId() tenantId: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Param('branchId') branchId: string,
    @Body() dto: CreateKitchenStationDto,
  ): Promise<KitchenStationView> {
    const created = await this.service.create(tenantId, branchId, dto);
    await this.audit.record(tenantId, {
      userId: actor.id,
      action: 'KITCHEN_STATION_CREATED',
      entityType: 'KitchenStation',
      entityId: created.id,
      metadata: { branchId, code: created.code, name: created.name, category: created.category },
    });
    return created;
  }

  @Patch(':stationId')
  @RequirePermissions(Permission.KITCHEN_STATION_MANAGE)
  async update(
    @TenantId() tenantId: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Param('branchId') branchId: string,
    @Param('stationId') stationId: string,
    @Body() dto: UpdateKitchenStationDto,
  ): Promise<KitchenStationView> {
    const before = await this.service.get(tenantId, branchId, stationId);
    const after = await this.service.update(tenantId, branchId, stationId, dto);
    await this.audit.record(tenantId, {
      userId: actor.id,
      action: 'KITCHEN_STATION_UPDATED',
      entityType: 'KitchenStation',
      entityId: stationId,
      metadata: {
        branchId,
        before: { name: before.name, category: before.category, isActive: before.isActive },
        after: { name: after.name, category: after.category, isActive: after.isActive },
      },
    });
    return after;
  }
}
