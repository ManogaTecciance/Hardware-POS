import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
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

  /**
   * D52 — channels that levy the service charge. Default `[DINE_IN]` matches
   * what the code did implicitly before this became configurable.
   */
  @IsOptional()
  @IsArray()
  @IsIn(['DINE_IN', 'TAKEAWAY', 'ONLINE'], { each: true })
  serviceChargeChannels?: string[];

  /** D52 — whether the service charge sits inside the taxable base. */
  @IsOptional() @IsBoolean() serviceChargeTaxable?: boolean;

  /** D52 — flat per-order packaging charge for TAKEAWAY / ONLINE. */
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  packagingChargeAmount?: number;

  /*
   * D67 — auto-printing, set once per branch by the owner. The printer ids
   * are workspace printers (KitchenPrinter rows); each user may then pick
   * their own defaults, which win over these.
   */
  @IsOptional() @IsBoolean() autoPrintKot?: boolean;
  @IsOptional() @IsBoolean() autoPrintBill?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(3) billCopies?: number;
  /** `null` clears the choice — no auto bill printing for the branch. */
  @IsOptional() @IsString() defaultReceiptPrinterId?: string | null;
  @IsOptional() @IsString() defaultKitchenPrinterId?: string | null;
}
