import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ModuleKey } from '@hardware-pos/database';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequireModule } from '../../common/decorators/require-module.decorator';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AuthenticatedUser } from '../auth/auth.types';
import { Permission } from '../auth/permissions';
import { CreateItemDto, UpdateItemDto } from './dto/menu.dto';
import { MenuItemView, MenuItemsService } from './menu-items.service';

@Controller('restaurant/menu-sections/:sectionId/items')
@RequireModule(ModuleKey.MENU_MANAGEMENT)
export class MenuItemsController {
  constructor(
    private readonly service: MenuItemsService,
    private readonly audit: AuditLogService,
  ) {}

  @Get()
  @RequirePermissions(Permission.PRODUCT_READ)
  list(
    @TenantId() tenantId: string,
    @Param('sectionId') sectionId: string,
    @Query('includeArchived') includeArchived?: string,
  ): Promise<MenuItemView[]> {
    return this.service.list(tenantId, sectionId, includeArchived === 'true');
  }

  @Post()
  @RequirePermissions(Permission.PRODUCT_MANAGE)
  async create(
    @TenantId() tenantId: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Param('sectionId') sectionId: string,
    @Body() dto: CreateItemDto,
  ): Promise<MenuItemView> {
    const created = await this.service.create(tenantId, sectionId, dto);
    await this.audit.record(tenantId, {
      userId: actor.id,
      action: 'MENU_ITEM_CREATED',
      entityType: 'MenuItem',
      entityId: created.id,
      metadata: {
        sectionId,
        name: created.name,
        basePrice: created.basePrice,
        productId: created.productId,
      },
    });
    return created;
  }

  @Patch(':itemId')
  @RequirePermissions(Permission.PRODUCT_MANAGE)
  async update(
    @TenantId() tenantId: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Param('sectionId') sectionId: string,
    @Param('itemId') itemId: string,
    @Body() dto: UpdateItemDto,
  ): Promise<MenuItemView> {
    const before = await this.service.get(tenantId, itemId);
    const after = await this.service.update(tenantId, itemId, dto);
    await this.audit.record(tenantId, {
      userId: actor.id,
      action: 'MENU_ITEM_UPDATED',
      entityType: 'MenuItem',
      entityId: itemId,
      metadata: {
        sectionId,
        before: {
          name: before.name,
          basePrice: before.basePrice,
          isActive: before.isActive,
        },
        after: {
          name: after.name,
          basePrice: after.basePrice,
          isActive: after.isActive,
        },
      },
    });
    return after;
  }
}
