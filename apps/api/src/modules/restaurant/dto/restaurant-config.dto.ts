import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsNumber,
  IsOptional,
  Max,
  Min,
} from 'class-validator';

/**
 * Restaurant Phase 2A. The service charge default is 0 (disabled) per D8;
 * an operator opts in explicitly. Values outside 0..100 are refused before
 * the row is written because a negative or >100% service charge is either
 * a typo or an attack on money maths downstream.
 */
export class UpdateRestaurantBranchConfigDto {
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  serviceChargePercent?: number;

  @IsOptional()
  @IsBoolean()
  takeawayEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  dineInEnabled?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(240)
  defaultTicketTargetMinutes?: number;

  /**
   * Optimistic concurrency token. When present, the update fails with 409 if
   * the row's version has moved. `0` means "expect no row" — the caller has
   * seen the defaults-only view and is creating the first row. Optional
   * because the very first PUT can omit it (the service treats absent as
   * "no expectation").
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  expectedVersion?: number;
}
