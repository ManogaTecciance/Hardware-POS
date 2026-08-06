import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { ModuleKey } from '@hardware-pos/database';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequireModule } from '../../common/decorators/require-module.decorator';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AuthenticatedUser } from '../auth/auth.types';
import { Permission } from '../auth/permissions';
import { CreateSectionDto, UpdateSectionDto } from './dto/menu.dto';
import { MenuService, SectionView } from './menu.service';

@Controller('restaurant/menus/:menuId/sections')
@RequireModule(ModuleKey.MENU_MANAGEMENT)
export class MenuSectionsController {
  constructor(
    private readonly service: MenuService,
    private readonly audit: AuditLogService,
  ) {}

  @Get()
  @RequirePermissions(Permission.PRODUCT_READ)
  list(
    @TenantId() tenantId: string,
    @Param('menuId') menuId: string,
  ): Promise<SectionView[]> {
    return this.service.listSections(tenantId, menuId);
  }

  @Post()
  @RequirePermissions(Permission.PRODUCT_MANAGE)
  async create(
    @TenantId() tenantId: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Param('menuId') menuId: string,
    @Body() dto: CreateSectionDto,
  ): Promise<SectionView> {
    const created = await this.service.createSection(tenantId, menuId, dto);
    await this.audit.record(tenantId, {
      userId: actor.id,
      action: 'MENU_SECTION_CREATED',
      entityType: 'MenuSection',
      entityId: created.id,
      metadata: { menuId, name: created.name },
    });
    return created;
  }

  @Patch(':sectionId')
  @RequirePermissions(Permission.PRODUCT_MANAGE)
  async update(
    @TenantId() tenantId: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Param('menuId') menuId: string,
    @Param('sectionId') sectionId: string,
    @Body() dto: UpdateSectionDto,
  ): Promise<SectionView> {
    const updated = await this.service.updateSection(tenantId, menuId, sectionId, dto);
    await this.audit.record(tenantId, {
      userId: actor.id,
      action: 'MENU_SECTION_UPDATED',
      entityType: 'MenuSection',
      entityId: sectionId,
      metadata: { menuId, name: updated.name, isActive: updated.isActive },
    });
    return updated;
  }
}
