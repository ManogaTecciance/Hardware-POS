import { Controller, Get, Query } from '@nestjs/common';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
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
/**
 * One id arrives as a string, several as an array; both read as a list. The
 * same shape the kitchen history filters use (D175) — a repeated query param
 * is what a set of ids looks like on the wire.
 */
function asIdList({ value }: { value: unknown }): unknown {
  if (value === undefined || value === null) return undefined;
  return Array.isArray(value) ? value : [value];
}

export class QuerySellableDto {
  @IsString() branchId!: string;
  /**
   * D198 — fetch NAMED products through the POS read model:
   * `?productId=x&productId=y`. The till needs the reward product of a
   * buy-X-get-Y offer (its name, price, variants and modifier groups) whether
   * or not the catalogue page it has loaded happens to contain it, and this
   * is the one endpoint that shapes a product the way the till consumes it —
   * a second lookup path would be a second place for the shape to drift.
   * Every other filter still applies, so a product outside this branch or
   * channel stays absent exactly as it would from the list.
   */
  @IsOptional()
  @Transform(asIdList)
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(128, { each: true })
  productId?: string[];
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
  /**
   * D64 — domain-attribute filters: `?attr[viewType]=Sea&attr[bedCount]=2`
   * (the extended query parser nests the brackets). Keys are validated
   * against the tenant descriptor's attribute schema and values are coerced
   * to the field's type in the service — an unknown key is a 400, not an
   * empty result.
   */
  @IsOptional() @IsObject() attr?: Record<string, string>;
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
