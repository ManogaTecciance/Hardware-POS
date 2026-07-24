import { SupplierQbStatus } from '@hardware-pos/database';
import { IsEnum, IsIn, IsOptional, IsString } from 'class-validator';

import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';

export const SUPPLIER_SORTS = ['name', 'company', 'dateAdded'] as const;

export type SupplierSort = (typeof SUPPLIER_SORTS)[number];

export class QuerySuppliersDto extends PaginationQueryDto {
  /** Free-text search across name, company, email, and phone. */
  @IsString()
  @IsOptional()
  search?: string;

  /** 'true' | 'false' string (kept as string so implicit conversion can't mangle it). */
  @IsIn(['true', 'false'])
  @IsOptional()
  isActive?: string;

  @IsEnum(SupplierQbStatus)
  @IsOptional()
  qbStatus?: SupplierQbStatus;

  @IsIn(SUPPLIER_SORTS as readonly string[])
  @IsOptional()
  sort?: SupplierSort;
}
