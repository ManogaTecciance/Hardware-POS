import { SyncStatus } from '@hardware-pos/database';
import { IsEnum, IsIn, IsOptional, IsString } from 'class-validator';

import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';

export type StockStatus = 'IN' | 'OUT' | 'LOW';

export class QueryProductsDto extends PaginationQueryDto {
  /** Free-text search across name and SKU. */
  @IsString()
  @IsOptional()
  search?: string;

  @IsString()
  @IsOptional()
  categoryId?: string;

  @IsString()
  @IsOptional()
  subcategoryId?: string;

  /** D133 (`8.9`) — "show me everything by this label". */
  @IsString()
  @IsOptional()
  brandId?: string;

  /**
   * Filter by active/inactive as a string ('true' | 'false'); omit to include
   * both. Kept as a string so the global implicit-conversion pipe can't mangle it.
   */
  @IsIn(['true', 'false'])
  @IsOptional()
  isActive?: string;

  /** QuickBooks item type filter. */
  @IsIn(['Inventory', 'NonInventory', 'Service'])
  @IsOptional()
  type?: string;

  @IsEnum(SyncStatus)
  @IsOptional()
  syncStatus?: SyncStatus;

  /** Stock status: IN (> 0), OUT (<= 0), or LOW (> 0 but at/below reorder point). */
  @IsIn(['IN', 'OUT', 'LOW'])
  @IsOptional()
  stockStatus?: StockStatus;
}
