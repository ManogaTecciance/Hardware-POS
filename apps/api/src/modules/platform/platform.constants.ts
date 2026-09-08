/**
 * Platform-profile defaults.
 *
 * This file is the ONLY place legacy-default logic lives. Controllers, guards,
 * services, and the front-end all read the resolved profile from
 * `BusinessProfileService` rather than re-deriving a fallback of their own — a
 * second copy of these defaults would be a second place for Tile Shop behaviour
 * to drift.
 */

import { AccountingProviderKind, BusinessType, InventoryMode, ModuleKey } from '@hardware-pos/database';
import { BUSINESS_TYPE_VALUES, domainFor } from '@hardware-pos/shared';

/** Every persisted module key, in declaration order. */
export const ALL_MODULE_KEYS: readonly ModuleKey[] = Object.values(ModuleKey);

/**
 * The configuration a tenant with NO `TenantBusinessProfile` row resolves to.
 *
 * This is not an arbitrary default — it is a description of how every tenant in
 * the database behaved before Slice 4 existed. QuickBooks is the inventory and
 * accounting master, and the full retail module set is enabled, so an
 * unconfigured tenant keeps its current POS navigation, inventory behaviour,
 * QuickBooks behaviour, quotations, returns, exchange document rendering,
 * suppliers, customers, reports, users, branches, settings, and branding.
 *
 * Changing any value here changes production behaviour for every tenant that has
 * not opted in to an explicit profile. Treat it as a compatibility contract.
 */
export const LEGACY_TENANT_DEFAULTS = {
  // D57: the value was TILE_SHOP until the PO ruled the pilot IS a
  // hardware-template business and the TILE_SHOP value was removed. Same
  // provider pair, same module list — the rename is the whole change.
  businessType: BusinessType.HARDWARE,
  inventoryMode: InventoryMode.QUICKBOOKS,
  accountingProvider: AccountingProviderKind.QUICKBOOKS,
  enabledModules: [
    ModuleKey.RETAIL_POS,
    ModuleKey.INVENTORY,
    ModuleKey.CUSTOMERS,
    ModuleKey.QUOTATIONS,
    ModuleKey.RETURNS,
    ModuleKey.EXCHANGES,
    ModuleKey.SUPPLIERS,
    ModuleKey.REPORTING,
    ModuleKey.USERS,
    ModuleKey.BRANCHES,
    ModuleKey.SETTINGS,
    ModuleKey.BRANDING,
    ModuleKey.QUICKBOOKS,
  ],
} as const;

/**
 * Default enabled modules per business type, derived from the domain registry
 * (D56) — the descriptors in `@hardware-pos/shared` are the one declaration,
 * shared with the web and the seeds. The cast from the shared string union to
 * the Prisma enum is sound because `platform-vocabulary.spec.ts` proves the
 * two vocabularies equal at runtime, in both directions.
 *
 * `PAYMENTS` appears in no set because it is not a module key: payment
 * collection is core to every profile and must never be switchable off.
 */
export const DEFAULT_MODULES_BY_BUSINESS_TYPE: Record<BusinessType, readonly ModuleKey[]> =
  Object.fromEntries(
    BUSINESS_TYPE_VALUES.map((businessType) => [
      businessType,
      domainFor(businessType).modules as readonly ModuleKey[],
    ]),
  ) as Record<BusinessType, readonly ModuleKey[]>;

/**
 * Sort a module list into `ModuleKey` declaration order.
 *
 * Callers compare module sets in tests and render them in navigation, so a
 * stable order keeps both deterministic regardless of row insertion order.
 */
export function sortModules(modules: Iterable<ModuleKey>): ModuleKey[] {
  const wanted = new Set(modules);
  return ALL_MODULE_KEYS.filter((key) => wanted.has(key));
}
