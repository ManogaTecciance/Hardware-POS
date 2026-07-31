import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@hardware-pos/database';
import { DEFAULT_CURRENCY } from '@hardware-pos/shared';

import { PrismaService } from '../../prisma/prisma.service';
import { UpdateSettingsDto } from './dto/update-settings.dto';
import { AppSettings, DocumentSettings } from './settings.interfaces';

/**
 * Per-tenant settings with DB persistence.
 *
 * The public `getSettings` stays synchronous — ~20 call sites across sales,
 * returns, quotations, receipts and documents read it inline — so it is served
 * from an in-memory cache hydrated from the `TenantSettings` table on boot
 * (`onModuleInit`) and kept warm on every write. A tenant with no stored row
 * falls back to the code defaults, so nothing breaks before an admin saves.
 *
 * Settings are stored as a single merged JSON document (`TenantSettings.data`)
 * so the shape can evolve without a migration per field; every read merges the
 * stored blob over fresh defaults so newly added fields appear automatically.
 */
@Injectable()
export class SettingsService implements OnModuleInit {
  private readonly logger = new Logger(SettingsService.name);
  private readonly cache = new Map<string, AppSettings>();

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    try {
      const rows = await this.prisma.tenantSettings.findMany({ where: { branchId: null } });
      for (const row of rows) {
        this.cache.set(row.tenantId, this.mergeOverDefaults(row.data));
      }
      this.logger.log(`Loaded persisted settings for ${rows.length} tenant(s)`);
    } catch (err) {
      // Never block boot on settings; fall back to defaults until a write warms the cache.
      this.logger.warn(`Could not preload tenant settings: ${(err as Error).message}`);
    }
  }

  /** Synchronous, cache-backed read. Returns code defaults for an unconfigured tenant. */
  getSettings(tenantId: string): AppSettings {
    return this.cache.get(tenantId) ?? this.defaults();
  }

  /** Deep-merge a partial update over the current settings, persist, warm the cache. */
  async updateSettings(tenantId: string, dto: UpdateSettingsDto): Promise<AppSettings> {
    const current = this.getSettings(tenantId);
    const next: AppSettings = {
      ...current,
      ...pickDefined(dto, [
        'currency',
        'taxRatePercent',
        'taxInclusive',
        'highDiscountThresholdPercent',
        'receiptFooter',
      ]),
      returns: { ...current.returns, ...definedOnly(dto.returns) },
      quotation: { ...current.quotation, ...definedOnly(dto.quotation) },
      documents: this.mergeDocuments(current.documents, dto.documents),
      sharing: { ...current.sharing, ...definedOnly(dto.sharing) },
    };

    // Manual upsert on (tenantId, branchId=null): Prisma's compound-unique input
    // types the nullable branchId as non-null, so we match by id instead.
    const existing = await this.prisma.tenantSettings.findFirst({
      where: { tenantId, branchId: null },
      select: { id: true },
    });
    const data = next as unknown as Prisma.InputJsonValue;
    if (existing) {
      await this.prisma.tenantSettings.update({ where: { id: existing.id }, data: { data } });
    } else {
      await this.prisma.tenantSettings.create({ data: { tenantId, branchId: null, data } });
    }
    this.cache.set(tenantId, next);
    return next;
  }

  /** Reset a tenant to code defaults (removes the stored row). */
  async resetSettings(tenantId: string): Promise<AppSettings> {
    await this.prisma.tenantSettings.deleteMany({ where: { tenantId, branchId: null } });
    this.cache.delete(tenantId);
    return this.defaults();
  }

  // ── merge helpers ──────────────────────────────────────────────

  /**
   * Document fields that are `string | null` on the model: an empty string from
   * the form clears them (→ null) so the renderer's `?? fallback` chain engages.
   */
  private mergeDocuments(
    current: DocumentSettings,
    dto: UpdateSettingsDto['documents'],
  ): DocumentSettings {
    if (!dto) return current;
    const nullable = new Set([
      'companyName',
      'addressLine',
      'phone',
      'email',
      'taxNumber',
      'logoUrl',
      'signatureUrl',
      'stampUrl',
    ]);
    const patch: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(dto)) {
      if (value === undefined) continue;
      patch[key] = nullable.has(key) && value === '' ? null : value;
    }
    return { ...current, ...(patch as Partial<DocumentSettings>) };
  }

  private mergeOverDefaults(data: Prisma.JsonValue): AppSettings {
    const d = this.defaults();
    const stored = (data ?? {}) as Partial<AppSettings>;
    return {
      ...d,
      ...stored,
      returns: { ...d.returns, ...(stored.returns ?? {}) },
      quotation: { ...d.quotation, ...(stored.quotation ?? {}) },
      documents: { ...d.documents, ...(stored.documents ?? {}) },
      sharing: { ...d.sharing, ...(stored.sharing ?? {}) },
    };
  }

  private defaults(): AppSettings {
    return {
      currency: DEFAULT_CURRENCY,
      taxRatePercent: 0,
      taxInclusive: false,
      highDiscountThresholdPercent: 10,
      receiptFooter: 'Thank you for your purchase!',
      returns: {
        returnPeriodDays: 30,
        cashierReturnValueLimit: 5000,
        allowStoreCredit: true,
        allowedRefundMethods: ['CASH', 'CARD', 'BANK_TRANSFER', 'STORE_CREDIT'],
        requireApprovalForNonGoodCondition: true,
        requireApprovalForOtherReason: false,
        quickbooksRefundReceiptDepositAccountRef: null,
      },
      quotation: {
        defaultValidityDays: 14,
        defaultTermsAndConditions:
          'This quotation is valid until the date shown above. Prices are subject to stock availability at the time of order. Goods once sold are subject to our standard return policy.',
        numberFormat: 'QT-{seq}',
        revisionFormat: '{number}-R{rev}',
        requireCustomer: false,
        allowWithoutStock: true,
        showStockAvailability: true,
        allowPriceOverride: true,
        requireApprovalAboveDiscountPercent: 15,
      },
      documents: {
        companyName: null,
        addressLine: null,
        phone: null,
        email: null,
        taxNumber: null,
        logoUrl: null,
        signatureUrl: null,
        stampUrl: null,
        footerText: 'Thank you for your business!',
        billNote: '',
        accentColor: '#1d4ed8',
        logoAlignment: 'LEFT',
        logoSize: 'MEDIUM',
        marginStyle: 'STANDARD',
        defaultPaperSize: 'A4',
        orientation: 'PORTRAIT',
        showProductImages: false,
        showSku: true,
        showTaxColumn: true,
        showDiscountColumn: true,
        showCustomerTaxNumber: true,
        showPageNumbers: true,
        defaultBillFormat: 'A4',
        signatureFields: true,
      },
      sharing: {
        emailSenderName: 'Hardware POS',
        emailSenderAddress: null,
        emailSubjectTemplate: 'Quotation {quotationNumber} from {businessName}',
        emailBodyTemplate:
          'Hello {customerName},\n\nPlease find attached quotation {quotationNumber}.\n\nThis quotation is valid until {validUntil}.\n\nThank you.',
        whatsappMessageTemplate:
          'Hello {customerName}, please find your quotation {quotationNumber} from {businessName}. The quotation is valid until {validUntil}.',
        shareLinkExpirationDays: 30,
        pdfStorageDurationDays: 90,
      },
    };
  }
}

/** Copy only the listed keys that are actually present (not undefined). */
function pickDefined<T extends object, K extends keyof T>(obj: T, keys: K[]): Partial<T> {
  const out: Partial<T> = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

/** Strip undefined values from a partial group so a merge never overwrites with undefined. */
function definedOnly<T extends object>(obj: T | undefined): Partial<T> {
  if (!obj) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out as Partial<T>;
}
