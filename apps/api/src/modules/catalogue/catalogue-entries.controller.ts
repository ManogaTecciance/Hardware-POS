import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AuthenticatedUser } from '../auth/auth.types';
import { Permission } from '../auth/permissions';
import { CatalogueService } from './catalogue.service';
import { UpdateEntryDto } from './dto/catalogue.dto';

/**
 * D62 — collections, sections and entries: the successor to the frozen menu
 * authoring surface (plan §9.2). Gated on MENU_MANAGEMENT like the surface
 * it replaces; retail tenants gain the module when Phase 9 flips their
 * `catalogue.collections` capability on — the routes are ready first.
 */
@Controller('entries/:entryId')
export class CatalogueEntriesController {
  constructor(
    private readonly service: CatalogueService,
    private readonly audit: AuditLogService,
  ) {}

  @Patch()
  @RequirePermissions(Permission.PRODUCT_MANAGE)
  update(
    @TenantId() tenantId: string,
    @Param('entryId') entryId: string,
    @Body() dto: UpdateEntryDto,
  ) {
    return this.service.updateEntry(tenantId, entryId, dto);
  }

  /** Archive, never hard-delete (D42/D43): history may reference the entry. */
  @Delete()
  @RequirePermissions(Permission.PRODUCT_MANAGE)
  async archive(
    @TenantId() tenantId: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Param('entryId') entryId: string,
  ) {
    const archived = await this.service.archiveEntry(tenantId, entryId);
    await this.audit.record(tenantId, {
      userId: actor.id,
      action: 'CATALOGUE_ENTRY_ARCHIVED',
      entityType: 'CatalogueEntry',
      entityId: entryId,
      metadata: { productId: archived.productId },
    });
    return archived;
  }
}
