import { PaymentStatus, SyncStatus } from '@hardware-pos/database';
import { Type } from 'class-transformer';
import {
  IsDate,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  MaxDate,
  MaxLength,
  MinDate,
} from 'class-validator';

import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';

// Sane calendar bounds: HTML date inputs happily produce 6-digit years, which
// Postgres timestamps reject — reply 400 instead of a 500 from Prisma.
const MIN_FILTER_DATE = new Date('1990-01-01T00:00:00Z');
const MAX_FILTER_DATE = new Date('2100-01-01T00:00:00Z');

export class QuerySalesDto extends PaginationQueryDto {
  /** Optionally filter the sales history by sync status (e.g. FAILED). */
  @IsEnum(SyncStatus)
  @IsOptional()
  syncStatus?: SyncStatus;

  /** Filter by payment status (PAID / PARTIAL / UNPAID / REFUNDED). */
  @IsEnum(PaymentStatus)
  @IsOptional()
  paymentStatus?: PaymentStatus;

  /** Free-text search over sale number or customer name. */
  @IsString()
  @IsOptional()
  @MaxLength(120)
  search?: string;

  /** Inclusive lower bound on the sale/invoice date (ISO string). */
  @Type(() => Date)
  @IsDate()
  @MinDate(MIN_FILTER_DATE)
  @MaxDate(MAX_FILTER_DATE)
  @IsOptional()
  dateFrom?: Date;

  /** Only this customer's sales. */
  @IsString()
  @IsOptional()
  customerId?: string;

  /** Only sales past their payment due date that still owe money. */
  @IsIn(['true'])
  @IsOptional()
  overdue?: string;

  /** Inclusive upper bound on the sale/invoice date (ISO string). */
  @Type(() => Date)
  @IsDate()
  @MinDate(MIN_FILTER_DATE)
  @MaxDate(MAX_FILTER_DATE)
  @IsOptional()
  dateTo?: Date;
}
