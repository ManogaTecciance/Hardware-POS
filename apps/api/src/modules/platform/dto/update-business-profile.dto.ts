import { AccountingProviderKind, BusinessType, InventoryMode, ModuleKey } from '@hardware-pos/database';
import { ArrayUnique, IsArray, IsEnum, IsOptional } from 'class-validator';

/**
 * Body of `PATCH /v1/platform/profile`.
 *
 * There is deliberately NO `tenantId` field. The tenant is taken from the
 * authenticated session server-side; adding one here would create exactly the
 * untrusted-tenant path decision D17 forbids. The global `ValidationPipe` runs
 * with `forbidNonWhitelisted`, so a client that sends `tenantId` anyway gets a
 * 400 rather than having it silently ignored.
 *
 * Every field is optional so a caller can change one thing without restating the
 * rest. Omitting `enabledModules` leaves module configuration untouched; sending
 * it replaces the configuration wholesale (modules not listed become explicitly
 * disabled).
 */
export class UpdateBusinessProfileDto {
  @IsOptional()
  @IsEnum(BusinessType)
  businessType?: BusinessType;

  @IsOptional()
  @IsEnum(InventoryMode)
  inventoryMode?: InventoryMode;

  @IsOptional()
  @IsEnum(AccountingProviderKind)
  accountingProvider?: AccountingProviderKind;

  /**
   * The complete set of modules to enable.
   *
   * `IsEnum` on each element rejects an unknown module key with a 400 before any
   * database work starts — unknown keys never reach the transaction. `ArrayUnique`
   * rejects a duplicated key rather than letting the upsert quietly absorb it, so
   * a client bug surfaces as an error instead of a silently different request.
   */
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsEnum(ModuleKey, { each: true })
  enabledModules?: ModuleKey[];
}
