import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@hardware-pos/database';
import { DEFAULT_CURRENCY } from '@hardware-pos/shared';

import { PrismaService } from '../../prisma/prisma.service';
import { UpdateSettingsDto } from './dto/update-settings.dto';
import { AppSettings, DocumentSettings } from './settings.interfaces';

/**
 * How stale a cached settings entry may be before it is revalidated (Slice 7.5).
 *
 * This value **is** the documented consistency guarantee. See the class comment.
 */
export const SETTINGS_CACHE_TTL_MS = 30_000;

interface CacheEntry {
  value: AppSettings;
  /** Epoch ms this entry was read from the database. */
  loadedAt: number;
}

/**
 * Per-tenant settings with DB persistence.
 *
 * The public `getSettings` is synchronous — ~20 call sites across sales, returns,
 * quotations, receipts and documents read it inline — so it is served from an
 * in-memory cache.
 *
 * ## The multi-replica problem this solves (Slice 7.5)
 *
 * Before 7.5 the cache was hydrated once at boot and refreshed only by writes made
 * *on that process*. With more than one API replica behind a load balancer that is
 * not merely stale, it is **permanently wrong**: an admin saving settings on
 * replica A left replica B serving the boot-time values forever, and a tenant
 * created after boot was served code defaults on every replica indefinitely,
 * regardless of what was in the table.
 *
 * ## The consistency guarantee
 *
 * Each entry records when it was read. A read of an entry older than
 * {@link SETTINGS_CACHE_TTL_MS} returns the cached value **and** schedules a
 * background refresh from the database. So:
 *
 *   A settings write is observable on every replica within
 *   SETTINGS_CACHE_TTL_MS + one database round trip,
 *   and immediately on the replica that performed the write.
 *
 * This is deliberately *eventual* consistency with a bounded, stated window rather
 * than a distributed invalidation scheme: settings are display and policy defaults
 * — currency, receipt footer, return windows — where a 30-second lag is
 * unremarkable. Anything that must be immediately correct across replicas (module
 * access, provider routing) does not go through this cache at all; the business
 * profile reads the database on every request precisely because a stale module
 * revocation would fail *open*. See decision D11.
 *
 * The refresh is fire-and-forget and deduplicated: a burst of reads on a stale
 * entry issues one query, not one per read.
 *
 * Settings are stored as a single merged JSON document (`TenantSettings.data`) so
 * the shape can evolve without a migration per field; every read merges the stored
 * blob over fresh defaults so newly added fields appear automatically.
 */
@Injectable()
export class SettingsService implements OnModuleInit {
  private readonly logger = new Logger(SettingsService.name);
  private readonly cache = new Map<string, CacheEntry>();
  /** Tenants with a refresh already in flight, so a burst issues one query. */
  private readonly refreshing = new Set<string>();

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    try {
      const rows = await this.prisma.tenantSettings.findMany({ where: { branchId: null } });
      const loadedAt = Date.now();
      for (const row of rows) {
        this.cache.set(row.tenantId, { value: this.mergeOverDefaults(row.data), loadedAt });
      }
      this.logger.log(`Loaded persisted settings for ${rows.length} tenant(s)`);
    } catch (err) {
      // Never block boot on settings; fall back to defaults until a read or write
      // warms the cache. The TTL refresh below means this is now self-healing
      // rather than permanent.
      this.logger.warn(`Could not preload tenant settings: ${(err as Error).message}`);
    }
  }

  /**
   * Synchronous, cache-backed read. Returns code defaults for an unconfigured
   * tenant, and schedules a refresh when the entry is older than the TTL.
   */
  getSettings(tenantId: string): AppSettings {
    const entry = this.cache.get(tenantId);
    if (!entry || Date.now() - entry.loadedAt >= SETTINGS_CACHE_TTL_MS) {
      // Missing counts as stale: a tenant created after this replica booted must
      // not be served defaults forever.
      this.scheduleRefresh(tenantId);
    }
    return entry?.value ?? this.defaults();
  }

  /**
   * Read straight through to the database, bypassing the cache.
   *
   * For callers that genuinely cannot tolerate the TTL window, and for tests that
   * assert the consistency guarantee without waiting for it.
   */
  async getSettingsFresh(tenantId: string): Promise<AppSettings> {
    await this.refreshNow(tenantId);
    return this.getSettings(tenantId);
  }

  /** Drop this replica's cached copy, forcing the next read to reload. */
  invalidate(tenantId: string): void {
    this.cache.delete(tenantId);
  }

  /** Fire-and-forget revalidation, deduplicated per tenant. */
  private scheduleRefresh(tenantId: string): void {
    if (this.refreshing.has(tenantId)) return;
    this.refreshing.add(tenantId);
    void this.refreshNow(tenantId).finally(() => this.refreshing.delete(tenantId));
  }

  private async refreshNow(tenantId: string): Promise<void> {
    try {
      const row = await this.prisma.tenantSettings.findFirst({
        where: { tenantId, branchId: null },
      });
      const loadedAt = Date.now();
      if (row) {
        this.cache.set(tenantId, { value: this.mergeOverDefaults(row.data), loadedAt });
      } else {
        // No row is a real answer — the tenant is on code defaults. Cache it so a
        // tenant that has never saved does not query on every single read.
        this.cache.set(tenantId, { value: this.defaults(), loadedAt });
      }
    } catch (err) {
      // Leave the previous value in place and try again after the next TTL lapse.
      // Serving slightly stale settings beats failing a sale over a receipt footer.
      this.logger.warn(
        `Could not refresh settings for tenant ${tenantId}: ${(err as Error).message}`,
      );
    }
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
    // The writing replica sees its own change immediately; every other replica
    // picks it up within the TTL.
    this.cache.set(tenantId, { value: next, loadedAt: Date.now() });
    return next;
  }

  /** Reset a tenant to code defaults (removes the stored row). */
  async resetSettings(tenantId: string): Promise<AppSettings> {
    await this.prisma.tenantSettings.deleteMany({ where: { tenantId, branchId: null } });
    this.cache.set(tenantId, { value: this.defaults(), loadedAt: Date.now() });
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
