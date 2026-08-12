import {
  BadRequestException,
  Controller,
  Inject,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';

import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { StorageService } from '../../common/storage/storage.service';
import { Permission } from '../auth/permissions';

/**
 * Standalone upload endpoint used by the Add Product wizard (D44).
 *
 * The wizard captures a photo before the Product exists, uploads it here, and
 * passes the returned URL as `imageUrl` on the subsequent create call. Sits on
 * its own controller so `POST /products/image` never collides with the
 * existing `POST /products/:id/image` route on `ProductsController`, which
 * still exists for the post-create replace-photo flow.
 *
 * Orphaned uploads (a wizard that never Saves) are the trade-off for a
 * create-time preview; a storage GC follow-up sweeps dangling assets. Same
 * shape as `MenuItemImagesController` so both wizards share the pattern.
 *
 * No `@RequireModule` — Products are `SHARED_CORE`, matching `ProductsController`.
 */
@Controller('products/image')
export class ProductImagesController {
  constructor(@Inject(StorageService) private readonly storage: StorageService) {}

  @Post()
  @RequirePermissions(Permission.PRODUCT_MANAGE)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024 } }))
  async upload(
    @UploadedFile() file: { buffer: Buffer; mimetype: string } | undefined,
  ): Promise<{ imageUrl: string }> {
    if (!file) {
      throw new BadRequestException('No file uploaded');
    }
    const url = await this.storage.saveImage(file);
    return { imageUrl: url };
  }
}
