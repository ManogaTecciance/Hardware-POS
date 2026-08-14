import { Controller, Post, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ModuleKey } from '@hardware-pos/database';

import { RequireModule } from '../../common/decorators/require-module.decorator';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { Permission } from '../auth/permissions';
import { MenuItemsService } from './menu-items.service';
import { assertMenuWritesAllowed } from './menu-writes-gone';

/**
 * Standalone upload endpoint used by the Add Menu Item wizard (D43).
 *
 * The wizard captures a photo before the MenuItem exists, uploads it here, and
 * passes the returned URL as `imageUrl` on the subsequent create call. Kept
 * on its own controller so the tenant-scoped `restaurant/menu-items/image`
 * path is free of the section-nested `restaurant/menu-sections/:sectionId/…`
 * prefix that binds every other menu-item endpoint.
 *
 * Orphaned uploads (a wizard that never Saves) are the trade-off for a
 * create-time preview; a storage GC follow-up will sweep dangling assets.
 */
@Controller('restaurant/menu-items/image')
@RequireModule(ModuleKey.MENU_MANAGEMENT)
export class MenuItemImagesController {
  constructor(private readonly service: MenuItemsService) {}

  @Post()
  @RequirePermissions(Permission.PRODUCT_MANAGE)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024 } }))
  upload(
    @TenantId() tenantId: string,
    @UploadedFile() file: { buffer: Buffer; mimetype: string } | undefined,
  ): Promise<{ imageUrl: string }> {
    assertMenuWritesAllowed(); // D60 — frozen; see menu-writes-gone.ts
    return this.service.uploadImage(tenantId, file);
  }
}
