import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AuthenticatedUser } from '../auth/auth.types';
import { Permission } from '../auth/permissions';
import { CatalogueService } from './catalogue.service';
import { CreateCollectionDto, ListCollectionsQueryDto } from './dto/catalogue.dto';

/**
 * D62 — collections, sections and entries: the successor to the frozen menu
 * authoring surface (plan §9.2).
 *
 * D66 — SHARED CORE since Phase 9, superseding D62's note that retail would
 * gain MENU_MANAGEMENT: the catalogue is shared core (the same doctrine as
 * `/products` and `/products/sellable`), and handing retail the menu module
 * would have opened the LEGACY restaurant menu routes to hardware tenants,
 * changing what D60's gate assertions mean. Instead, writes are refused by
 * the service for tenants whose domain does not declare
 * `capabilities.catalogue.collections` — the D65 components pattern.
 */
@Controller('branches/:branchId/collections')
export class CollectionsController {
  constructor(
    private readonly service: CatalogueService,
    private readonly audit: AuditLogService,
  ) {}

  @Get()
  @RequirePermissions(Permission.PRODUCT_READ)
  list(
    @TenantId() tenantId: string,
    @Param('branchId') branchId: string,
    @Query() query: ListCollectionsQueryDto,
  ) {
    return this.service.listCollections(tenantId, branchId, query.channel);
  }

  @Post()
  @RequirePermissions(Permission.PRODUCT_MANAGE)
  async create(
    @TenantId() tenantId: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Param('branchId') branchId: string,
    @Body() dto: CreateCollectionDto,
  ) {
    const created = await this.service.createCollection(tenantId, branchId, dto);
    await this.audit.record(tenantId, {
      userId: actor.id,
      action: 'COLLECTION_CREATED',
      entityType: 'Menu',
      entityId: created.id,
      metadata: { branchId, name: created.name },
    });
    return created;
  }
}
