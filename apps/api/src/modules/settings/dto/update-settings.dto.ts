import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  Validate,
  ValidateNested,
  ValidatorConstraint,
  type ValidatorConstraintInterface,
} from 'class-validator';
import { isValidTimeZone } from '@hardware-pos/shared';

/** Accepts only an IANA zone this runtime can actually resolve. */
@ValidatorConstraint({ name: 'isIanaTimeZone', async: false })
export class IsIanaTimeZone implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return typeof value === 'string' && isValidTimeZone(value);
  }

  defaultMessage(): string {
    return 'timezone must be a valid IANA timezone name (e.g. Asia/Colombo)';
  }
}

/** The tenders a refund can be paid in, as accepted map keys. */
const REFUND_TENDERS = [
  'CASH',
  'CARD',
  'BANK_TRANSFER',
  'QR_PAYMENT',
  'CHECK',
  'STORE_CREDIT',
  'OTHER',
] as const;

/**
 * A `PaymentMethod` → QuickBooks account id map. Keys are rejected rather than
 * ignored: a typo'd tender would otherwise be stored, look configured in the
 * settings payload, and never be consulted by the sync.
 */
@ValidatorConstraint({ name: 'isRefundDepositAccountMap', async: false })
export class IsRefundDepositAccountMap implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    return Object.entries(value).every(
      ([key, id]) =>
        (REFUND_TENDERS as readonly string[]).includes(key) &&
        typeof id === 'string' &&
        id.trim().length > 0 &&
        id.length <= 100,
    );
  }

  defaultMessage(): string {
    return `quickbooksRefundDepositAccountRefs must map ${REFUND_TENDERS.join(' / ')} to a non-empty QuickBooks account id`;
  }
}

export class UpdateReturnSettingsDto {
  @IsInt()
  @Min(0)
  @Max(3650)
  @IsOptional()
  returnPeriodDays?: number;

  @IsNumber()
  @Min(0)
  @IsOptional()
  cashierReturnValueLimit?: number;

  @IsBoolean()
  @IsOptional()
  allowStoreCredit?: boolean;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  allowedRefundMethods?: string[];

  @IsBoolean()
  @IsOptional()
  requireApprovalForNonGoodCondition?: boolean;

  @IsBoolean()
  @IsOptional()
  requireApprovalForOtherReason?: boolean;

  @IsString()
  @IsOptional()
  quickbooksRefundReceiptDepositAccountRef?: string;

  @Validate(IsRefundDepositAccountMap)
  @IsOptional()
  quickbooksRefundDepositAccountRefs?: Record<string, string>;
}

export class UpdateQuotationSettingsDto {
  @IsInt()
  @Min(0)
  @Max(3650)
  @IsOptional()
  defaultValidityDays?: number;

  @IsString()
  @IsOptional()
  defaultTermsAndConditions?: string;

  @IsString()
  @IsOptional()
  numberFormat?: string;

  @IsString()
  @IsOptional()
  revisionFormat?: string;

  @IsBoolean()
  @IsOptional()
  requireCustomer?: boolean;

  @IsBoolean()
  @IsOptional()
  allowWithoutStock?: boolean;

  @IsBoolean()
  @IsOptional()
  showStockAvailability?: boolean;

  @IsBoolean()
  @IsOptional()
  allowPriceOverride?: boolean;

  @IsNumber()
  @Min(0)
  @Max(100)
  @IsOptional()
  requireApprovalAboveDiscountPercent?: number;
}

export class UpdateDocumentSettingsDto {
  @IsString()
  @IsOptional()
  companyName?: string;

  @IsString()
  @IsOptional()
  addressLine?: string;

  @IsString()
  @IsOptional()
  phone?: string;

  @IsString()
  @IsOptional()
  email?: string;

  @IsString()
  @IsOptional()
  taxNumber?: string;

  @IsString()
  @IsOptional()
  logoUrl?: string;

  @IsString()
  @IsOptional()
  signatureUrl?: string;

  @IsString()
  @IsOptional()
  stampUrl?: string;

  @IsString()
  @IsOptional()
  footerText?: string;

  @IsString()
  @IsOptional()
  @MaxLength(500)
  billNote?: string;

  @Matches(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, { message: 'accentColor must be a hex colour' })
  @IsOptional()
  accentColor?: string;

  @IsIn(['LEFT', 'CENTER', 'RIGHT'])
  @IsOptional()
  logoAlignment?: 'LEFT' | 'CENTER' | 'RIGHT';

  @IsIn(['SMALL', 'MEDIUM', 'LARGE'])
  @IsOptional()
  logoSize?: 'SMALL' | 'MEDIUM' | 'LARGE';

  @IsIn(['COMPACT', 'STANDARD', 'SPACIOUS'])
  @IsOptional()
  marginStyle?: 'COMPACT' | 'STANDARD' | 'SPACIOUS';

  @IsIn(['A4', 'THERMAL_80'])
  @IsOptional()
  defaultPaperSize?: 'A4' | 'THERMAL_80';

  @IsIn(['PORTRAIT', 'LANDSCAPE'])
  @IsOptional()
  orientation?: 'PORTRAIT' | 'LANDSCAPE';

  @IsBoolean()
  @IsOptional()
  showProductImages?: boolean;

  @IsBoolean()
  @IsOptional()
  showSku?: boolean;

  @IsBoolean()
  @IsOptional()
  showTaxColumn?: boolean;

  @IsBoolean()
  @IsOptional()
  showDiscountColumn?: boolean;

  @IsBoolean()
  @IsOptional()
  showCustomerTaxNumber?: boolean;

  @IsBoolean()
  @IsOptional()
  showPageNumbers?: boolean;

  @IsIn(['A4', 'THERMAL', 'BOTH'])
  @IsOptional()
  defaultBillFormat?: 'A4' | 'THERMAL' | 'BOTH';

  @IsBoolean()
  @IsOptional()
  signatureFields?: boolean;
}

export class UpdateSharingSettingsDto {
  @IsString()
  @IsOptional()
  emailSenderName?: string;

  @IsString()
  @IsOptional()
  emailSenderAddress?: string;

  @IsString()
  @IsOptional()
  emailSubjectTemplate?: string;

  @IsString()
  @IsOptional()
  emailBodyTemplate?: string;

  @IsString()
  @IsOptional()
  whatsappMessageTemplate?: string;

  @IsInt()
  @Min(0)
  @Max(3650)
  @IsOptional()
  shareLinkExpirationDays?: number;

  @IsInt()
  @Min(0)
  @Max(3650)
  @IsOptional()
  pdfStorageDurationDays?: number;
}

export class UpdateSettingsDto {
  @IsString()
  @IsOptional()
  currency?: string;

  /** Shop timezone (IANA, e.g. `Asia/Colombo`). Rejected unless the runtime knows it. */
  @IsString()
  @Validate(IsIanaTimeZone)
  @IsOptional()
  timezone?: string;

  @IsNumber()
  @Min(0)
  @Max(100)
  @IsOptional()
  taxRatePercent?: number;

  @IsBoolean()
  @IsOptional()
  taxInclusive?: boolean;

  @IsNumber()
  @Min(0)
  @Max(100)
  @IsOptional()
  highDiscountThresholdPercent?: number;

  @IsString()
  @IsOptional()
  receiptFooter?: string;

  @ValidateNested()
  @Type(() => UpdateReturnSettingsDto)
  @IsOptional()
  returns?: UpdateReturnSettingsDto;

  @ValidateNested()
  @Type(() => UpdateQuotationSettingsDto)
  @IsOptional()
  quotation?: UpdateQuotationSettingsDto;

  @ValidateNested()
  @Type(() => UpdateDocumentSettingsDto)
  @IsOptional()
  documents?: UpdateDocumentSettingsDto;

  @ValidateNested()
  @Type(() => UpdateSharingSettingsDto)
  @IsOptional()
  sharing?: UpdateSharingSettingsDto;
}
