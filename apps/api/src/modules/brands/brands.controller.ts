import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';

import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { Permission } from '../auth/permissions';
import { BrandsService, type BrandView } from './brands.service';
import { CreateBrandDto, QueryBrandsDto, UpdateBrandDto } from './dto/brand.dto';

/**
 * Brands — D112 (`8.9`).
 *
 * No `@RequireModule`: brands belong to the product catalogue, which is shared
 * core. Gating them on `INVENTORY` would hide a tenant's own labels from them
 * because they do not track stock, which is the mistake the Products entry in
 * the navigation already documents.
 *
 * Permissioned like the catalogue it is part of: read with `product:read`,
 * write with `product:manage`. No delete route exists — archiving is the
 * operation, and a route that did not exist could not be called by mistake.
 */
@Controller('brands')
export class BrandsController {
  constructor(private readonly service: BrandsService) {}

  @Get()
  @RequirePermissions(Permission.PRODUCT_READ)
  list(@TenantId() tenantId: string, @Query() query: QueryBrandsDto): Promise<BrandView[]> {
    return this.service.list(tenantId, query.includeArchived === 'true');
  }

  @Post()
  @RequirePermissions(Permission.PRODUCT_MANAGE)
  create(@TenantId() tenantId: string, @Body() dto: CreateBrandDto): Promise<BrandView> {
    return this.service.create(tenantId, dto);
  }

  @Patch(':id')
  @RequirePermissions(Permission.PRODUCT_MANAGE)
  update(
    @TenantId() tenantId: string,
    @Param('id') id: string,
    @Body() dto: UpdateBrandDto,
  ): Promise<BrandView> {
    return this.service.update(tenantId, id, dto);
  }
}
