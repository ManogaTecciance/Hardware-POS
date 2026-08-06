import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ModuleKey } from '@hardware-pos/database';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequireModule } from '../../common/decorators/require-module.decorator';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AuthenticatedUser } from '../auth/auth.types';
import { Permission } from '../auth/permissions';
import { CreateMenuDto, UpdateMenuDto } from './dto/menu.dto';
import { MenuService, MenuView } from './menu.service';

@Controller('restaurant/branches/:branchId/menus')
@RequireModule(ModuleKey.MENU_MANAGEMENT)
export class MenusController {
  constructor(
    private readonly service: MenuService,
    private readonly audit: AuditLogService,
  ) {}

  @Get()
  @RequirePermissions(Permission.PRODUCT_READ)
  list(
    @TenantId() tenantId: string,
    @Param('branchId') branchId: string,
    @Query('includeArchived') includeArchived?: string,
  ): Promise<MenuView[]> {
    return this.service.listMenus(tenantId, branchId, includeArchived === 'true');
  }

  @Post()
  @RequirePermissions(Permission.PRODUCT_MANAGE)
  async create(
    @TenantId() tenantId: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Param('branchId') branchId: string,
    @Body() dto: CreateMenuDto,
  ): Promise<MenuView> {
    const created = await this.service.createMenu(tenantId, branchId, dto);
    await this.audit.record(tenantId, {
      userId: actor.id,
      action: 'MENU_CREATED',
      entityType: 'Menu',
      entityId: created.id,
      metadata: { branchId, name: created.name },
    });
    return created;
  }

  @Patch(':menuId')
  @RequirePermissions(Permission.PRODUCT_MANAGE)
  async update(
    @TenantId() tenantId: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Param('branchId') branchId: string,
    @Param('menuId') menuId: string,
    @Body() dto: UpdateMenuDto,
  ): Promise<MenuView> {
    const before = await this.service.listMenus(tenantId, branchId, true).then((rows) => rows.find((m) => m.id === menuId));
    const after = await this.service.updateMenu(tenantId, branchId, menuId, dto);
    await this.audit.record(tenantId, {
      userId: actor.id,
      action: 'MENU_UPDATED',
      entityType: 'Menu',
      entityId: menuId,
      metadata: {
        branchId,
        before: before && { name: before.name, isActive: before.isActive },
        after: { name: after.name, isActive: after.isActive },
      },
    });
    return after;
  }
}
