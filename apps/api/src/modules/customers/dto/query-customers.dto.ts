import { CustomerType } from '@hardware-pos/database';
import { IsEnum, IsIn, IsOptional, IsString } from 'class-validator';

import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';

export class QueryCustomersDto extends PaginationQueryDto {
  /** Free-text search across name, company, email, and phone. */
  @IsString()
  @IsOptional()
  search?: string;

  @IsEnum(CustomerType)
  @IsOptional()
  customerType?: CustomerType;

  /** 'true' | 'false' string (kept as string so implicit conversion can't mangle it). */
  @IsIn(['true', 'false'])
  @IsOptional()
  isActive?: string;

  /** Only customers who currently owe money — the dashboard receivables card links here. */
  @IsIn(['true'])
  @IsOptional()
  hasOutstandingCredit?: string;
}
