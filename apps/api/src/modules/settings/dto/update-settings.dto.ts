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

  /*
   * D99 — thermal paper geometry. The bounds are not taste: a page narrower
   * than 40mm is not a receipt roll, and insets that swallow the column would
   * render a bill with nowhere to print the amounts. The client-side resolver
   * clamps as well, because the web app renders from a cached profile that
   * never passed through this DTO.
   */
  @IsNumber()
  @Min(40)
  @Max(120)
  @IsOptional()
  billPaperWidthMm?: number;

  @IsNumber()
  @Min(0)
  @Max(20)
  @IsOptional()
  billLeftInsetMm?: number;

  @IsNumber()
  @Min(0)
  @Max(20)
  @IsOptional()
  billRightInsetMm?: number;

  @IsBoolean()
  @IsOptional()
  billFitToContent?: boolean;
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

/** Phase 5 `5.8` — label geometry, in millimetres. */
export class UpdateLabelSettingsDto {
  @IsNumber()
  @Min(10)
  @Max(300)
  @IsOptional()
  widthMm?: number;

  @IsNumber()
  @Min(10)
  @Max(300)
  @IsOptional()
  heightMm?: number;

  @IsInt()
  @Min(1)
  @Max(20)
  @IsOptional()
  columns?: number;

  @IsInt()
  @Min(1)
  @Max(50)
  @IsOptional()
  rows?: number;

  @IsNumber()
  @Min(0)
  @Max(100)
  @IsOptional()
  marginTopMm?: number;

  @IsNumber()
  @Min(0)
  @Max(100)
  @IsOptional()
  marginLeftMm?: number;

  @IsNumber()
  @Min(0)
  @Max(50)
  @IsOptional()
  gapXMm?: number;

  @IsNumber()
  @Min(0)
  @Max(50)
  @IsOptional()
  gapYMm?: number;

  @IsBoolean()
  @IsOptional()
  showProductName?: boolean;

  @IsBoolean()
  @IsOptional()
  showVariantOptions?: boolean;

  @IsBoolean()
  @IsOptional()
  showPrice?: boolean;

  @IsBoolean()
  @IsOptional()
  showSku?: boolean;

  @IsIn(['EAN13', 'CODE128'])
  @IsOptional()
  symbology?: 'EAN13' | 'CODE128';
}

/** D125 Part 3 `5.4` + `5.8`. */
export class UpdateCatalogueSettingsDto {
  /**
   * 2-6 digits starting `02` or `20`-`29`. The shape is checked here; the GS1
   * range rule is checked by the shared `ean13PrefixIssue`, so the API and the
   * settings form give the identical explanation for a refusal.
   *
   * `null` is allowed and means "not configured" — allocation then refuses,
   * which is the D125 sequencing constraint made real rather than documented.
   */
  @Matches(/^\d{2,6}$/)
  @IsOptional()
  barcodePrefix?: string | null;

  @IsOptional()
  barcodePrefixByCategoryId?: Record<string, string>;

  @ValidateNested()
  @Type(() => UpdateLabelSettingsDto)
  @IsOptional()
  label?: UpdateLabelSettingsDto;
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
  @Type(() => UpdateCatalogueSettingsDto)
  @IsOptional()
  catalogue?: UpdateCatalogueSettingsDto;

  @ValidateNested()
  @Type(() => UpdateSharingSettingsDto)
  @IsOptional()
  sharing?: UpdateSharingSettingsDto;
}
