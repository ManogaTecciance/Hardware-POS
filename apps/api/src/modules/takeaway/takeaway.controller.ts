import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, Query } from '@nestjs/common';
import { ModuleKey } from '@hardware-pos/database';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequireModule } from '../../common/decorators/require-module.decorator';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AuthenticatedUser } from '../auth/auth.types';
import { Permission } from '../auth/permissions';
import { CreateTakeawayDto, UpdateTakeawayStatusDto } from './dto/takeaway.dto';
import { TakeawayService, TakeawayView } from './takeaway.service';

@Controller('restaurant/takeaway')
@RequireModule(ModuleKey.TAKEAWAY)
export class TakeawayController {
  constructor(
    private readonly service: TakeawayService,
    private readonly audit: AuditLogService,
  ) {}

  @Get()
  @RequirePermissions(Permission.TAKEAWAY_VIEW)
  list(
    @TenantId() tenantId: string,
    @Query('branchId') branchId: string,
  ): Promise<TakeawayView[]> {
    return this.service.list(tenantId, branchId);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions(Permission.TAKEAWAY_CREATE)
  async create(
    @TenantId() tenantId: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Body() dto: CreateTakeawayDto,
  ): Promise<TakeawayView> {
    const created = await this.service.create(tenantId, dto, actor.id);
    await this.audit.record(tenantId, {
      userId: actor.id,
      action: 'TAKEAWAY_ORDER_CREATED',
      entityType: 'TakeawayOrderProfile',
      entityId: created.id,
      metadata: {
        branchId: dto.branchId,
        orderNumber: created.orderNumber,
        customerName: dto.customerName,
      },
    });
    return created;
  }

  @Patch(':profileId/status')
  @RequirePermissions(Permission.TAKEAWAY_CREATE)
  async updateStatus(
    @TenantId() tenantId: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Param('profileId') profileId: string,
    @Body() dto: UpdateTakeawayStatusDto,
  ): Promise<TakeawayView> {
    const updated = await this.service.updateStatus(tenantId, profileId, dto, actor.id);
    await this.audit.record(tenantId, {
      userId: actor.id,
      action: 'TAKEAWAY_ORDER_STATUS_CHANGED',
      entityType: 'TakeawayOrderProfile',
      entityId: profileId,
      metadata: { newStatus: dto.status },
    });
    return updated;
  }
}
