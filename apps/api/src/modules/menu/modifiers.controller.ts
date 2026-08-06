import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ModuleKey } from '@hardware-pos/database';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequireModule } from '../../common/decorators/require-module.decorator';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AuthenticatedUser } from '../auth/auth.types';
import { Permission } from '../auth/permissions';
import { CreateModifierGroupDto, UpdateModifierGroupDto } from './dto/menu.dto';
import { ModifierGroupView, ModifiersService } from './modifiers.service';

@Controller('restaurant/modifier-groups')
@RequireModule(ModuleKey.MENU_MANAGEMENT)
export class ModifiersController {
  constructor(
    private readonly service: ModifiersService,
    private readonly audit: AuditLogService,
  ) {}

  @Get()
  @RequirePermissions(Permission.PRODUCT_READ)
  list(
    @TenantId() tenantId: string,
    @Query('includeArchived') includeArchived?: string,
  ): Promise<ModifierGroupView[]> {
    return this.service.list(tenantId, includeArchived === 'true');
  }

  @Get(':groupId')
  @RequirePermissions(Permission.PRODUCT_READ)
  get(
    @TenantId() tenantId: string,
    @Param('groupId') groupId: string,
  ): Promise<ModifierGroupView> {
    return this.service.get(tenantId, groupId);
  }

  @Post()
  @RequirePermissions(Permission.PRODUCT_MANAGE)
  async create(
    @TenantId() tenantId: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Body() dto: CreateModifierGroupDto,
  ): Promise<ModifierGroupView> {
    const created = await this.service.create(tenantId, dto);
    await this.audit.record(tenantId, {
      userId: actor.id,
      action: 'MODIFIER_GROUP_CREATED',
      entityType: 'ModifierGroup',
      entityId: created.id,
      metadata: { name: created.name, optionCount: created.options.length },
    });
    return created;
  }

  @Patch(':groupId')
  @RequirePermissions(Permission.PRODUCT_MANAGE)
  async update(
    @TenantId() tenantId: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Param('groupId') groupId: string,
    @Body() dto: UpdateModifierGroupDto,
  ): Promise<ModifierGroupView> {
    const after = await this.service.update(tenantId, groupId, dto);
    await this.audit.record(tenantId, {
      userId: actor.id,
      action: 'MODIFIER_GROUP_UPDATED',
      entityType: 'ModifierGroup',
      entityId: groupId,
      metadata: {
        name: after.name,
        selection: after.selection,
        min: after.minSelections,
        max: after.maxSelections,
        isActive: after.isActive,
      },
    });
    return after;
  }
}
