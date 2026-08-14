import { Controller, Get, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { OrderChannel, SellableKind } from '@hardware-pos/database';

import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { Permission } from '../auth/permissions';
import { SellableService, type SellableResponse } from './sellable.service';

/**
 * D62 — `GET /products/sellable`: the one POS read model, for every domain.
 *
 * SHARED CORE, deliberately: the catalogue is shared core (the same reasoning
 * that leaves `GET /products` ungated by module), and which BLOCKS the
 * response carries is decided by capabilities, not by a module key. The
 * legacy `/restaurant/pos-catalogue` alias delegates here until its sunset.
 */
export class QuerySellableDto {
  @IsString() branchId!: string;
  @IsOptional() @IsIn(['COUNTER', 'DINE_IN', 'TAKEAWAY', 'ONLINE'])
  channel?: OrderChannel;
  @IsOptional() @IsString() collectionId?: string;
  @IsOptional() @IsString() categoryId?: string;
  @IsOptional()
  @IsIn(['STOCK_ITEM', 'COMPOSED_ITEM', 'SERVICE', 'BUNDLE', 'TIME_SLOT', 'STAY_UNIT'])
  sellableKind?: SellableKind;
  @IsOptional() @IsIn(['FOOD', 'BEVERAGE', 'DESSERT'])
  foodType?: 'FOOD' | 'BEVERAGE' | 'DESSERT';
  @IsOptional() @IsString() search?: string;
  @IsOptional() @IsString() cursor?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
}

@Controller('products/sellable')
export class SellableController {
  constructor(private readonly service: SellableService) {}

  @Get()
  @RequirePermissions(Permission.PRODUCT_READ)
  list(@TenantId() tenantId: string, @Query() query: QuerySellableDto): Promise<SellableResponse> {
    return this.service.list(tenantId, query);
  }
}
