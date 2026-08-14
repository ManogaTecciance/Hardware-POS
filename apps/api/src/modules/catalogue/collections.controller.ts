import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { ModuleKey } from '@hardware-pos/database';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequireModule } from '../../common/decorators/require-module.decorator';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AuthenticatedUser } from '../auth/auth.types';
import { Permission } from '../auth/permissions';
import { CatalogueService } from './catalogue.service';
import { CreateCollectionDto } from './dto/catalogue.dto';

/**
 * D62 — collections, sections and entries: the successor to the frozen menu
 * authoring surface (plan §9.2). Gated on MENU_MANAGEMENT like the surface
 * it replaces; retail tenants gain the module when Phase 9 flips their
 * `catalogue.collections` capability on — the routes are ready first.
 */
@Controller('branches/:branchId/collections')
@RequireModule(ModuleKey.MENU_MANAGEMENT)
export class CollectionsController {
  constructor(
    private readonly service: CatalogueService,
    private readonly audit: AuditLogService,
  ) {}

  @Get()
  @RequirePermissions(Permission.PRODUCT_READ)
  list(@TenantId() tenantId: string, @Param('branchId') branchId: string) {
    return this.service.listCollections(tenantId, branchId);
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
