import { Injectable, Logger } from '@nestjs/common';
import { ModuleKey } from '@hardware-pos/database';

import { UpdateBusinessProfileDto } from './dto/update-business-profile.dto';
import {
  DEFAULT_MODULES_BY_BUSINESS_TYPE,
  LEGACY_TENANT_DEFAULTS,
  sortModules,
} from './platform.constants';
import { BusinessProfileRepository, PersistedProfile } from './business-profile.repository';
import { EffectiveBusinessProfile, ModuleState } from './platform.types';

/**
 * The single authority for "what is this tenant configured as".
 *
 * Callers — the module guard, the platform controller, and from Slice 5 the
 * provider factories — ask this service and get a fully resolved
 * {@link EffectiveBusinessProfile}. Nobody else implements a fallback: legacy
 * defaults exist in exactly one place (`platform.constants.ts`) and are applied
 * in exactly one place (here).
 *
 * No cross-request cache, deliberately (decision D11). The profile is an
 * authorization input; caching a revocation for even a short TTL would fail open
 * on every replica for the length of that TTL. Reads are two indexed queries on a
 * unique/indexed `tenantId`.
 */
@Injectable()
export class BusinessProfileService {
  private readonly logger = new Logger(BusinessProfileService.name);

  constructor(private readonly repository: BusinessProfileRepository) {}

  /**
   * Resolve the effective profile for a tenant.
   *
   * No row → the legacy Tile Shop configuration, reported as `LEGACY_DEFAULT`.
   * A row → its stored values, reported as `EXPLICIT`, with modules resolved as
   * described on {@link resolveModules}.
   */
  async getEffectiveProfile(tenantId: string): Promise<EffectiveBusinessProfile> {
    return this.toEffective(await this.repository.findByTenant(tenantId));
  }

  /**
   * Per-module view for the authenticated tenant, including modules that are off.
   *
   * Slice 8's dynamic navigation needs to know the difference between "disabled"
   * and "never configured", which a bare list of enabled keys cannot express.
   */
  async getModuleStates(tenantId: string): Promise<ModuleState[]> {
    const persisted = await this.repository.findByTenant(tenantId);
    const effective = this.toEffective(persisted);
    const enabled = new Set(effective.enabledModules);
    const explicit = new Set(persisted.modules.map((row) => row.moduleKey));

    // Union of everything with an opinion: explicit rows plus whatever the
    // resolved profile turns on. Modules nobody has an opinion about are omitted
    // rather than listed as a wall of `false`.
    const relevant = sortModules([...enabled, ...explicit]);
    return relevant.map((moduleKey) => ({
      moduleKey,
      isEnabled: enabled.has(moduleKey),
      isExplicit: explicit.has(moduleKey),
    }));
  }

  /**
   * Is one module enabled for this tenant?
   *
   * The guard's single question. Kept here rather than in the guard so module
   * resolution has one implementation.
   */
  async isModuleEnabled(tenantId: string, moduleKey: ModuleKey): Promise<boolean> {
    const profile = await this.getEffectiveProfile(tenantId);
    return profile.enabledModules.includes(moduleKey);
  }

  /**
   * Create or update the authenticated tenant's explicit profile.
   *
   * `tenantId` comes from the caller (the controller passes the authenticated
   * session's tenant) and is never read from the request body — there is no
   * `tenantId` field on {@link UpdateBusinessProfileDto} for a client to set.
   *
   * The profile row and the module rows are written in one transaction, so a
   * rejected module key leaves neither changed.
   */
  async updateProfile(
    tenantId: string,
    dto: UpdateBusinessProfileDto,
  ): Promise<EffectiveBusinessProfile> {
    const persisted = await this.repository.upsertProfile(
      tenantId,
      {
        businessType: dto.businessType,
        inventoryMode: dto.inventoryMode,
        accountingProvider: dto.accountingProvider,
      },
      dto.enabledModules,
      (businessType) => DEFAULT_MODULES_BY_BUSINESS_TYPE[businessType],
    );
    this.logger.log(
      `Platform profile written for tenant ${tenantId}: ` +
        `${persisted.profile?.businessType}/${persisted.profile?.inventoryMode}/` +
        `${persisted.profile?.accountingProvider} v${persisted.profile?.version}`,
    );
    return this.toEffective(persisted);
  }

  // ── resolution ─────────────────────────────────────────────────

  private toEffective(persisted: PersistedProfile): EffectiveBusinessProfile {
    const { profile } = persisted;
    if (!profile) {
      return {
        source: 'LEGACY_DEFAULT',
        businessType: LEGACY_TENANT_DEFAULTS.businessType,
        inventoryMode: LEGACY_TENANT_DEFAULTS.inventoryMode,
        accountingProvider: LEGACY_TENANT_DEFAULTS.accountingProvider,
        enabledModules: sortModules(LEGACY_TENANT_DEFAULTS.enabledModules),
        version: null,
        updatedAt: null,
      };
    }

    return {
      source: 'EXPLICIT',
      businessType: profile.businessType,
      inventoryMode: profile.inventoryMode,
      accountingProvider: profile.accountingProvider,
      enabledModules: this.resolveModules(persisted),
      version: profile.version,
      updatedAt: profile.updatedAt,
    };
  }

  /**
   * Resolve the enabled module set for a tenant that has an explicit profile.
   *
   * An explicit `TenantModule` row always wins, in both directions — `isEnabled:
   * false` is a revocation and must not be overridden by the business-type
   * default. Modules with no row fall back to the default set for the business
   * type, so a tenant created before a new module shipped picks it up without a
   * data migration.
   */
  private resolveModules(persisted: PersistedProfile): ModuleKey[] {
    const { profile, modules } = persisted;
    if (!profile) {
      return sortModules(LEGACY_TENANT_DEFAULTS.enabledModules);
    }

    const stated = new Map(modules.map((row) => [row.moduleKey, row.isEnabled]));
    const enabled = new Set<ModuleKey>();

    for (const moduleKey of DEFAULT_MODULES_BY_BUSINESS_TYPE[profile.businessType]) {
      if (stated.get(moduleKey) !== false) {
        enabled.add(moduleKey);
      }
    }
    for (const [moduleKey, isEnabled] of stated) {
      if (isEnabled) {
        enabled.add(moduleKey);
      }
    }
    return sortModules(enabled);
  }
}
