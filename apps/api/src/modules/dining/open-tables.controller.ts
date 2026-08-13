import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ModuleKey } from '@hardware-pos/database';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequireModule } from '../../common/decorators/require-module.decorator';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AuthenticatedUser } from '../auth/auth.types';
import { Permission } from '../auth/permissions';
import { CreateOpenTableDto } from './dto/dining.dto';
import { DiningService, OpenTableView } from './dining.service';

/**
 * D49 — open tables: ad-hoc joined tables. Creation reserves the physical
 * member tables; release happens automatically on bill close
 * (table-sessions.service) or manually here via dissolve.
 */
@Controller('restaurant/branches/:branchId/open-tables')
@RequireModule(ModuleKey.TABLE_MANAGEMENT)
export class OpenTablesController {
  constructor(
    private readonly service: DiningService,
    private readonly audit: AuditLogService,
  ) {}

  @Get()
  @RequirePermissions(Permission.PLATFORM_PROFILE_READ)
  list(@TenantId() tenantId: string, @Param('branchId') branchId: string): Promise<OpenTableView[]> {
    return this.service.listOpenTables(tenantId, branchId);
  }

  @Post()
  @RequirePermissions(Permission.OPEN_TABLE_MANAGE)
  async create(
    @TenantId() tenantId: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Param('branchId') branchId: string,
    @Body() dto: CreateOpenTableDto,
  ): Promise<OpenTableView> {
    const created = await this.service.createOpenTable(tenantId, branchId, actor.id, dto);
    await this.audit.record(tenantId, {
      userId: actor.id,
      action: 'OPEN_TABLE_CREATED',
      entityType: 'RestaurantTable',
      entityId: created.id,
      metadata: {
        branchId,
        code: created.code,
        name: created.label,
        seats: created.capacity,
        memberTableIds: created.members.map((m) => m.id),
      },
    });
    return created;
  }

  /** Manual dissolve for an arrangement that was never seated. */
  @Delete(':openTableId')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.OPEN_TABLE_MANAGE)
  async dissolve(
    @TenantId() tenantId: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Param('branchId') branchId: string,
    @Param('openTableId') openTableId: string,
  ): Promise<OpenTableView> {
    const dissolved = await this.service.dissolveOpenTable(tenantId, branchId, openTableId);
    await this.audit.record(tenantId, {
      userId: actor.id,
      action: 'OPEN_TABLE_DISSOLVED',
      entityType: 'RestaurantTable',
      entityId: openTableId,
      metadata: { branchId, code: dissolved.code, name: dissolved.label },
    });
    return dissolved;
  }
}
