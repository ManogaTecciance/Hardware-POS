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
import { CreateTableDto, UpdateTableDto } from './dto/dining.dto';
import { DiningService, RestaurantTableView } from './dining.service';

@Controller('restaurant/dining-areas/:areaId/tables')
@RequireModule(ModuleKey.TABLE_MANAGEMENT)
export class RestaurantTablesController {
  constructor(
    private readonly service: DiningService,
    private readonly audit: AuditLogService,
  ) {}

  @Get()
  @RequirePermissions(Permission.PLATFORM_PROFILE_READ)
  list(
    @TenantId() tenantId: string,
    @Param('areaId') areaId: string,
    @Query('includeArchived') includeArchived?: string,
  ): Promise<RestaurantTableView[]> {
    return this.service.listTables(tenantId, areaId, includeArchived === 'true');
  }

  @Post()
  @RequirePermissions(Permission.TABLE_CREATE)
  async create(
    @TenantId() tenantId: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Param('areaId') areaId: string,
    @Body() dto: CreateTableDto,
  ): Promise<RestaurantTableView> {
    const created = await this.service.createTable(tenantId, areaId, actor.id, dto);
    await this.audit.record(tenantId, {
      userId: actor.id,
      action: 'RESTAURANT_TABLE_CREATED',
      entityType: 'RestaurantTable',
      entityId: created.id,
      metadata: {
        areaId,
        code: created.code,
        capacity: created.capacity,
        createdByUserId: created.createdByUserId,
      },
    });
    return created;
  }

  @Patch(':tableId')
  @RequirePermissions(Permission.TABLE_EDIT_OWN)
  async update(
    @TenantId() tenantId: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Param('areaId') areaId: string,
    @Param('tableId') tableId: string,
    @Body() dto: UpdateTableDto,
  ): Promise<RestaurantTableView> {
    const updated = await this.service.updateTable(tenantId, areaId, tableId, actor.id, dto);
    await this.audit.record(tenantId, {
      userId: actor.id,
      action: 'RESTAURANT_TABLE_UPDATED',
      entityType: 'RestaurantTable',
      entityId: tableId,
      metadata: { areaId, capacity: updated.capacity, label: updated.label },
    });
    return updated;
  }

  @Delete(':tableId')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.TABLE_ARCHIVE_OWN)
  async archive(
    @TenantId() tenantId: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Param('areaId') areaId: string,
    @Param('tableId') tableId: string,
  ): Promise<RestaurantTableView> {
    const archived = await this.service.archiveTable(tenantId, areaId, tableId, actor.id);
    await this.audit.record(tenantId, {
      userId: actor.id,
      action: 'RESTAURANT_TABLE_ARCHIVED',
      entityType: 'RestaurantTable',
      entityId: tableId,
      metadata: { areaId, code: archived.code },
    });
    return archived;
  }
}
