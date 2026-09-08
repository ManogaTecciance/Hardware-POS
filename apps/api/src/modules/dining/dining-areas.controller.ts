import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ModuleKey } from '@hardware-pos/database';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequireModule } from '../../common/decorators/require-module.decorator';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AuthenticatedUser } from '../auth/auth.types';
import { Permission } from '../auth/permissions';
import { CreateDiningAreaDto, UpdateDiningAreaDto } from './dto/dining.dto';
import { DiningAreaView, DiningService } from './dining.service';

@Controller('restaurant/branches/:branchId/dining-areas')
@RequireModule(ModuleKey.DINING)
export class DiningAreasController {
  constructor(
    private readonly service: DiningService,
    private readonly audit: AuditLogService,
  ) {}

  @Get()
  @RequirePermissions(Permission.PLATFORM_PROFILE_READ)
  list(
    @TenantId() tenantId: string,
    @Param('branchId') branchId: string,
    @Query('includeArchived') includeArchived?: string,
  ): Promise<DiningAreaView[]> {
    return this.service.listAreas(tenantId, branchId, includeArchived === 'true');
  }

  @Post()
  @RequirePermissions(Permission.DINING_AREA_CREATE)
  async create(
    @TenantId() tenantId: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Param('branchId') branchId: string,
    @Body() dto: CreateDiningAreaDto,
  ): Promise<DiningAreaView> {
    const created = await this.service.createArea(tenantId, branchId, actor.id, dto);
    await this.audit.record(tenantId, {
      userId: actor.id,
      action: 'DINING_AREA_CREATED',
      entityType: 'DiningArea',
      entityId: created.id,
      metadata: { branchId, name: created.name, createdByUserId: created.createdByUserId },
    });
    return created;
  }

  @Patch(':areaId')
  @RequirePermissions(Permission.DINING_AREA_EDIT_OWN)
  async update(
    @TenantId() tenantId: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Param('branchId') branchId: string,
    @Param('areaId') areaId: string,
    @Body() dto: UpdateDiningAreaDto,
  ): Promise<DiningAreaView> {
    const updated = await this.service.updateArea(tenantId, branchId, areaId, actor.id, dto);
    await this.audit.record(tenantId, {
      userId: actor.id,
      action: 'DINING_AREA_UPDATED',
      entityType: 'DiningArea',
      entityId: areaId,
      metadata: { branchId, name: updated.name },
    });
    return updated;
  }

  /**
   * Archive (soft-delete). Kept as a DELETE for verb clarity; the row is
   * marked `isActive=false` rather than physically removed, so historical
   * sessions/orders/reports still resolve against it.
   */
  @Delete(':areaId')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.DINING_AREA_ARCHIVE_OWN)
  async archive(
    @TenantId() tenantId: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Param('branchId') branchId: string,
    @Param('areaId') areaId: string,
  ): Promise<DiningAreaView> {
    const archived = await this.service.archiveArea(tenantId, branchId, areaId, actor.id);
    await this.audit.record(tenantId, {
      userId: actor.id,
      action: 'DINING_AREA_ARCHIVED',
      entityType: 'DiningArea',
      entityId: areaId,
      metadata: { branchId, name: archived.name },
    });
    return archived;
  }
}
