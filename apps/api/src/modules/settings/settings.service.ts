import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@hardware-pos/database';
import {
  DEFAULT_CURRENCY,
  DEFAULT_TIME_ZONE,
  safeTimeZone,
  type AttributeField,
} from '@hardware-pos/shared';

import { PrismaService } from '../../prisma/prisma.service';
import { UpdateSettingsDto } from './dto/update-settings.dto';
import { AppSettings, DocumentSettings } from './settings.interfaces';

/**
 * How stale a cached settings entry may be before it is revalidated (Slice 7.5).
 *
 * This value **is** the documented consistency guarantee. See the class comment
 * and Phase 1.5.8 for the "two-tier" separation between this (non-security,
 * eventual) and the read-through path used by roles, users, branch access and
 * module access (authoritative on the next validated request).
 */
export const SETTINGS_CACHE_TTL_MS = 30_000;

/**
 * The two-tier consistency contract (Phase 1.5.8).
 *
 * Tier 1 — authoritative on the next validated request. Used by:
 *   - `PermissionResolver` (roles / permissions / user activation)
 *   - `BranchScopeGuard` (branch access, branch active state)
 *   - `ModuleAccessGuard` via `BusinessProfileService`
 *   - Anything gating a mutation
 * These paths query the database on every request. They must never take a
 * value from a process-local cache — a stale revocation would fail *open*.
 *
 * Tier 2 — documented eventual consistency, at most `SETTINGS_CACHE_TTL_MS`.
 *   - Branding, receipt presentation, business preferences, UI configuration
 * A 30-second lag on a receipt footer is unremarkable, and the alternative
 * (a database round trip on every hot-path read) is not.
 *
 * Anything security-sensitive that also happens to live in `TenantSettings`
 * MUST be read via `getSettingsFresh()` — never `getSettings()`.
 */
export const SETTINGS_TIER = {
  MAX_NON_SECURITY_STALENESS_MS: SETTINGS_CACHE_TTL_MS,
} as const;

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
        'timezone',
        'taxRatePercent',
        'taxInclusive',
        'highDiscountThresholdPercent',
        'receiptFooter',
      ]),
      returns: { ...current.returns, ...definedOnly(dto.returns) },
      quotation: { ...current.quotation, ...definedOnly(dto.quotation) },
      documents: this.mergeDocuments(current.documents, dto.documents),
      sharing: { ...current.sharing, ...definedOnly(dto.sharing) },
      // Explicit, like `documents` above: without it the spread leaks the DTO's
      // own optional type into AppSettings and `barcodePrefix` widens to
      // `string | null | undefined`. `label` is merged separately so a partial
      // geometry update keeps the fields it did not mention.
      catalogue: {
        ...current.catalogue,
        ...definedOnly(dto.catalogue),
        label: { ...current.catalogue.label, ...definedOnly(dto.catalogue?.label) },
      },
    };

    await this.persist(tenantId, next);
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

  /**
   * D138 — replace the tenant's business-detail field list.
   *
   * Its own method rather than a field on `UpdateCatalogueSettingsDto`, and
   * that is the point: removing a field that products still hold values for has
   * to be REFUSED, and that check needs to read products. Routing it through
   * the generic settings endpoint would hand every caller a way past the
   * refusal. `BusinessDetailsService` owns the rule and calls this once it
   * holds.
   *
   * `undefined` CLEARS the override, so the tenant falls back to its domain's
   * declared schema. That is a different state from `[]`, which means “we track
   * no business details” and hides the wizard step entirely.
   */
  async replaceBusinessDetails(
    tenantId: string,
    fields: AttributeField[] | undefined,
  ): Promise<AppSettings> {
    const current = this.getSettings(tenantId);
    const catalogue = { ...current.catalogue };
    if (fields === undefined) delete catalogue.businessDetails;
    else catalogue.businessDetails = fields;
    const next: AppSettings = { ...current, catalogue };
    await this.persist(tenantId, next);
    return next;
  }

  /**
   * Write the whole document, and make this replica's cache agree with it.
   *
   * Manual upsert on (tenantId, branchId=null): Prisma's compound-unique input
   * types the nullable branchId as non-null, so we match by id instead.
   */
  private async persist(tenantId: string, next: AppSettings): Promise<void> {
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
  }

  private mergeOverDefaults(data: Prisma.JsonValue): AppSettings {
    const d = this.defaults();
    const stored = (data ?? {}) as Partial<AppSettings>;
    return {
      ...d,
      ...stored,
      // Guarded on read as well as write: a zone that a hand-edited row or an
      // older runtime's ICU cannot resolve would otherwise reach every document
      // formatter and throw there instead of here.
      timezone: safeTimeZone(stored.timezone),
      returns: { ...d.returns, ...(stored.returns ?? {}) },
      quotation: { ...d.quotation, ...(stored.quotation ?? {}) },
      documents: { ...d.documents, ...(stored.documents ?? {}) },
      sharing: { ...d.sharing, ...(stored.sharing ?? {}) },
      catalogue: {
        ...d.catalogue,
        ...(stored.catalogue ?? {}),
        label: { ...d.catalogue.label, ...(stored.catalogue?.label ?? {}) },
      },
    };
  }

  private defaults(): AppSettings {
    return {
      currency: DEFAULT_CURRENCY,
      timezone: DEFAULT_TIME_ZONE,
      taxRatePercent: 0,
      taxInclusive: false,
      highDiscountThresholdPercent: 10,
      receiptFooter: 'Thank you for your purchase!',
      catalogue: {
        // NULL, deliberately. Allocation refuses until an operator chooses one,
        // because a prefix picked by default and then changed means reprinting
        // every label the shop has already produced.
        barcodePrefix: null,
        barcodePrefixByCategoryId: {},
        label: {
          // 38 x 21 mm, 5 x 13 on A4 — the commonest off-the-shelf sheet.
          widthMm: 38,
          heightMm: 21,
          columns: 5,
          rows: 13,
          marginTopMm: 10,
          marginLeftMm: 5,
          gapXMm: 2,
          gapYMm: 0,
          showProductName: true,
          showVariantOptions: true,
          showPrice: true,
          showSku: false,
          symbology: 'EAN13',
        },
      },
      returns: {
        returnPeriodDays: 30,
        cashierReturnValueLimit: 5000,
        allowStoreCredit: true,
        allowedRefundMethods: ['CASH', 'CARD', 'BANK_TRANSFER', 'STORE_CREDIT'],
        requireApprovalForNonGoodCondition: true,
        requireApprovalForOtherReason: false,
        quickbooksRefundReceiptDepositAccountRef: null,
        quickbooksRefundDepositAccountRefs: {},
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
        // A SKU is an internal identifier; a customer reading a bill has no
        // use for it. The COLUMN stays — it is a real setting with a real
        // toggle (Settings → Documents → “Product SKU column”) and a shop that
        // wants it can have it — but a new workspace does not start with it.
        // Existing tenants persist their own value and are unaffected.
        showSku: false,
        showTaxColumn: true,
        showDiscountColumn: true,
        showCustomerTaxNumber: true,
        showPageNumbers: true,
        defaultBillFormat: 'A4',
        signatureFields: true,
        // D99 — the Xprinter XP-365B's stock is 78.7mm wide and its head stops
        // short of the right edge (D80 measured the clip at ~3.5mm). The 3mm of
        // LEFT slack is the new number: it is what a refitting browser takes
        // its overflow from instead of taking it out of the first character.
        billPaperWidthMm: 78,
        billLeftInsetMm: 3,
        billRightInsetMm: 5,
        billFitToContent: true,
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
