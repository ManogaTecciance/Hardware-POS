import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AuthenticatedUser } from '../auth/auth.types';
import { Permission } from '../auth/permissions';
import { CatalogueService } from './catalogue.service';
import { CreateSectionDto, UpdateCollectionDto } from './dto/catalogue.dto';

/**
 * D62 — collections, sections and entries: the successor to the frozen menu
 * authoring surface (plan §9.2). Gated on MENU_MANAGEMENT like the surface
 * it replaces; retail tenants gain the module when Phase 9 flips their
 * `catalogue.collections` capability on — the routes are ready first.
 */
@Controller('collections/:collectionId')
export class CollectionController {
  constructor(
    private readonly service: CatalogueService,
    private readonly audit: AuditLogService,
  ) {}

  @Patch()
  @RequirePermissions(Permission.PRODUCT_MANAGE)
  async update(
    @TenantId() tenantId: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Param('collectionId') collectionId: string,
    @Body() dto: UpdateCollectionDto,
  ) {
    const updated = await this.service.updateCollection(tenantId, collectionId, dto);
    await this.audit.record(tenantId, {
      userId: actor.id,
      action: 'COLLECTION_UPDATED',
      entityType: 'Menu',
      entityId: collectionId,
      metadata: { name: updated.name, isActive: updated.isActive },
    });
    return updated;
  }

  @Get('sections')
  @RequirePermissions(Permission.PRODUCT_READ)
  listSections(@TenantId() tenantId: string, @Param('collectionId') collectionId: string) {
    return this.service.listSections(tenantId, collectionId);
  }

  @Post('sections')
  @RequirePermissions(Permission.PRODUCT_MANAGE)
  async createSection(
    @TenantId() tenantId: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Param('collectionId') collectionId: string,
    @Body() dto: CreateSectionDto,
  ) {
    const created = await this.service.createSection(tenantId, collectionId, dto);
    await this.audit.record(tenantId, {
      userId: actor.id,
      action: 'COLLECTION_SECTION_CREATED',
      entityType: 'MenuSection',
      entityId: created.id,
      metadata: { collectionId, name: created.name },
    });
    return created;
  }
}
