import { AccountingProviderKind, BusinessType, InventoryMode, ModuleKey } from '@hardware-pos/database';

/**
 * Where a resolved profile came from.
 *
 * `LEGACY_DEFAULT` means the tenant has no `TenantBusinessProfile` row and is
 * running the pre-Slice-4 Tile Shop configuration. That is a supported state, not
 * an error or a "not yet set up" warning — the front-end must not nag about it.
 */
export type ProfileSource = 'EXPLICIT' | 'LEGACY_DEFAULT';

/**
 * The fully resolved platform configuration for one tenant, with every fallback
 * already applied. This is the only shape callers should consume; nothing
 * downstream should ever look at a raw `TenantBusinessProfile` row and decide
 * what a missing value means.
 */
export interface EffectiveBusinessProfile {
  source: ProfileSource;
  businessType: BusinessType;
  inventoryMode: InventoryMode;
  accountingProvider: AccountingProviderKind;
  /** Enabled modules, in `ModuleKey` declaration order. */
  enabledModules: ModuleKey[];
  /**
   * Optimistic-concurrency token of the persisted row, or `null` for a legacy
   * default (there is no row to version).
   */
  version: number | null;
  updatedAt: Date | null;
}

/** One module and whether it is on for this tenant — the `GET /platform/modules` row shape. */
export interface ModuleState {
  moduleKey: ModuleKey;
  isEnabled: boolean;
  /**
   * `true` when a `TenantModule` row states this explicitly; `false` when the
   * value comes from the business-type default (or the legacy default set).
   */
  isExplicit: boolean;
}
