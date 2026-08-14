import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AuthenticatedUser } from '../auth/auth.types';
import { Permission } from '../auth/permissions';
import { CreateModifierGroupDto, UpdateModifierGroupDto } from '../menu/dto/menu.dto';
import { ModifiersService, type ModifierGroupView } from '../menu/modifiers.service';

/**
 * D62 — modifier groups under their real home (convergence plan §9.2).
 *
 * A modifier group is SHARED CATALOGUE — "cut to 3 keys +$6" at a hardware
 * counter and "add bacon +$2" at a grill are the same feature — so its
 * canonical path is `/products/modifier-groups`, not `/restaurant/…`. The
 * old path stays as a deprecated alias until its sunset; both delegate to
 * one service. No module key, matching `/products` itself: the catalogue is
 * shared core, and whether a tenant's UI OFFERS modifiers is a capability
 * (`catalogue.modifiers`), not a route guard.
 */
@Controller('products/modifier-groups')
export class ProductModifierGroupsController {
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
  get(@TenantId() tenantId: string, @Param('groupId') groupId: string): Promise<ModifierGroupView> {
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
      metadata: { name: created.name },
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
    const updated = await this.service.update(tenantId, groupId, dto);
    await this.audit.record(tenantId, {
      userId: actor.id,
      action: 'MODIFIER_GROUP_UPDATED',
      entityType: 'ModifierGroup',
      entityId: groupId,
      metadata: { name: updated.name },
    });
    return updated;
  }
}
