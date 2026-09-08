import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';

import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { RequirePermissions } from '../../../common/decorators/permissions.decorator';
import { TenantId } from '../../../common/decorators/tenant-id.decorator';
import { AuthenticatedUser } from '../../auth/auth.types';
import { Permission } from '../../auth/permissions';
import { CreateVariantBatchDto } from './dto/create-variant-batch.dto';
import { UpdateVariantDto } from './dto/update-variant.dto';
import { ReplaceVariationsDto } from './dto/variation-dimensions.dto';
import {
  ProductVariantsService,
  VariantBranchInventoryView,
  VariantPurchaseView,
  VariantView,
  VariationDimensionView,
} from './product-variants.service';

/**
 * ProductVariant + variation endpoints.
 *
 * Nested under `products/:productId` so the URLs mirror the tree the wizard
 * navigates. Every write requires `PRODUCT_MANAGE`; reads use `PRODUCT_READ`
 * so a cashier can browse variants for lookup without editing them (D40).
 */
@Controller('products/:productId')
export class ProductVariantsController {
  constructor(private readonly service: ProductVariantsService) {}

  // ── Variations ─────────────────────────────────────────────────────────────

  @Get('variations')
  @RequirePermissions(Permission.PRODUCT_READ)
  listVariations(
    @TenantId() tenantId: string,
    @Param('productId') productId: string,
  ): Promise<{ dimensions: VariationDimensionView[] }> {
    return this.service.listVariations(tenantId, productId);
  }

  @Put('variations')
  @RequirePermissions(Permission.PRODUCT_MANAGE)
  replaceVariations(
    @TenantId() tenantId: string,
    @Param('productId') productId: string,
    @Body() dto: ReplaceVariationsDto,
  ): Promise<{ dimensions: VariationDimensionView[] }> {
    return this.service.replaceVariations(tenantId, productId, dto);
  }

  // ── Variants ───────────────────────────────────────────────────────────────

  @Get('variants')
  @RequirePermissions(Permission.PRODUCT_READ)
  listVariants(
    @TenantId() tenantId: string,
    @Param('productId') productId: string,
  ): Promise<VariantView[]> {
    return this.service.listVariants(tenantId, productId);
  }

  // Colon-suffix route (`variants:batch`) matches the wizard's URL shape; Nest
  // treats the segment literally because there is no leading colon.
  @Post('variants:batch')
  @RequirePermissions(Permission.PRODUCT_MANAGE)
  createBatch(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('productId') productId: string,
    @Body() dto: CreateVariantBatchDto,
  ): Promise<VariantView[]> {
    return this.service.createVariantsBatch(tenantId, productId, user.id, dto);
  }

  @Patch('variants/:variantId')
  @RequirePermissions(Permission.PRODUCT_MANAGE)
  updateVariant(
    @TenantId() tenantId: string,
    @Param('productId') productId: string,
    @Param('variantId') variantId: string,
    @Body() dto: UpdateVariantDto,
  ): Promise<VariantView> {
    return this.service.updateVariant(tenantId, productId, variantId, dto);
  }

  @Delete('variants/:variantId')
  @RequirePermissions(Permission.PRODUCT_MANAGE)
  deleteVariant(
    @TenantId() tenantId: string,
    @Param('productId') productId: string,
    @Param('variantId') variantId: string,
  ): Promise<{ id: string }> {
    return this.service.deleteVariant(tenantId, productId, variantId);
  }

  @Post('variants/:variantId/image')
  @RequirePermissions(Permission.PRODUCT_MANAGE)
  // Multer memory storage → file.buffer is available for `StorageService`.
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024 } }))
  uploadImage(
    @TenantId() tenantId: string,
    @Param('productId') productId: string,
    @Param('variantId') variantId: string,
    @UploadedFile() file: { buffer: Buffer; mimetype: string } | undefined,
  ): Promise<VariantView> {
    return this.service.setImage(tenantId, productId, variantId, file);
  }

  @Delete('variants/:variantId/image')
  @RequirePermissions(Permission.PRODUCT_MANAGE)
  removeImage(
    @TenantId() tenantId: string,
    @Param('productId') productId: string,
    @Param('variantId') variantId: string,
  ): Promise<VariantView> {
    return this.service.removeImage(tenantId, productId, variantId);
  }

  @Get('variants/:variantId/inventory')
  @RequirePermissions(Permission.PRODUCT_READ)
  inventory(
    @TenantId() tenantId: string,
    @Param('productId') productId: string,
    @Param('variantId') variantId: string,
  ): Promise<{ branches: VariantBranchInventoryView[] }> {
    return this.service.getInventory(tenantId, productId, variantId);
  }

  @Get('variants/:variantId/purchases')
  @RequirePermissions(Permission.PRODUCT_READ)
  purchases(
    @TenantId() tenantId: string,
    @Param('productId') productId: string,
    @Param('variantId') variantId: string,
  ): Promise<VariantPurchaseView[]> {
    return this.service.getPurchases(tenantId, productId, variantId);
  }
}
