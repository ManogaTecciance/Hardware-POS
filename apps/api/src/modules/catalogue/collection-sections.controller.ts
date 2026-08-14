import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AuthenticatedUser } from '../auth/auth.types';
import { Permission } from '../auth/permissions';
import { CatalogueService } from './catalogue.service';
import { CreateEntryDto, UpdateSectionDto } from './dto/catalogue.dto';

/**
 * D62 — collections, sections and entries: the successor to the frozen menu
 * authoring surface (plan §9.2). Gated on MENU_MANAGEMENT like the surface
 * it replaces; retail tenants gain the module when Phase 9 flips their
 * `catalogue.collections` capability on — the routes are ready first.
 */
@Controller('sections/:sectionId')
export class CollectionSectionsController {
  constructor(
    private readonly service: CatalogueService,
    private readonly audit: AuditLogService,
  ) {}

  @Patch()
  @RequirePermissions(Permission.PRODUCT_MANAGE)
  update(
    @TenantId() tenantId: string,
    @Param('sectionId') sectionId: string,
    @Body() dto: UpdateSectionDto,
  ) {
    return this.service.updateSection(tenantId, sectionId, dto);
  }

  @Get('entries')
  @RequirePermissions(Permission.PRODUCT_READ)
  listEntries(@TenantId() tenantId: string, @Param('sectionId') sectionId: string) {
    return this.service.listEntries(tenantId, sectionId);
  }

  @Post('entries')
  @RequirePermissions(Permission.PRODUCT_MANAGE)
  async createEntry(
    @TenantId() tenantId: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Param('sectionId') sectionId: string,
    @Body() dto: CreateEntryDto,
  ) {
    const created = await this.service.createEntry(tenantId, sectionId, dto);
    await this.audit.record(tenantId, {
      userId: actor.id,
      action: 'CATALOGUE_ENTRY_CREATED',
      entityType: 'CatalogueEntry',
      entityId: created.id,
      metadata: { sectionId, productId: created.productId },
    });
    return created;
  }
}
