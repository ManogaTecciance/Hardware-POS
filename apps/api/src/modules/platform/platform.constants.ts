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
  businessType: BusinessType.TILE_SHOP,
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

/** Modules every business profile gets — the shared AxloPOS core. */
const SHARED_CORE_MODULES: readonly ModuleKey[] = [
  ModuleKey.CUSTOMERS,
  ModuleKey.REPORTING,
  ModuleKey.USERS,
  ModuleKey.BRANCHES,
  ModuleKey.SETTINGS,
  ModuleKey.BRANDING,
];

/** Retail/trade modules, on top of the shared core. */
const RETAIL_MODULES: readonly ModuleKey[] = [
  ModuleKey.RETAIL_POS,
  ModuleKey.INVENTORY,
  ModuleKey.QUOTATIONS,
  ModuleKey.RETURNS,
  ModuleKey.EXCHANGES,
  ModuleKey.SUPPLIERS,
  ModuleKey.QUICKBOOKS,
];

/**
 * Food-service modules, on top of the shared core.
 *
 * Deliberately excludes `QUOTATIONS`, `RETURNS`, `SUPPLIERS`, `QUICKBOOKS`, and
 * `EXCHANGES` (decision D2). `KITCHEN_DISPLAY`, `ONLINE_ORDERS`,
 * `DELIVERY_INTEGRATIONS`, and `RESERVATIONS` are opt-in rather than default,
 * matching the Release 1 / Release 2 boundary.
 */
const RESTAURANT_MODULES: readonly ModuleKey[] = [
  ModuleKey.MENU_MANAGEMENT,
  ModuleKey.DINING,
  ModuleKey.TABLE_MANAGEMENT,
  ModuleKey.TAKEAWAY,
  ModuleKey.KITCHEN,
];

/**
 * Default enabled modules per business type, used when a tenant has an explicit
 * profile but has expressed no per-module opinion.
 *
 * `PAYMENTS` appears in no set because it is not a module key: payment
 * collection is core to every profile and must never be switchable off.
 */
export const DEFAULT_MODULES_BY_BUSINESS_TYPE: Record<BusinessType, readonly ModuleKey[]> = {
  [BusinessType.TILE_SHOP]: [...SHARED_CORE_MODULES, ...RETAIL_MODULES],
  [BusinessType.HARDWARE]: [...SHARED_CORE_MODULES, ...RETAIL_MODULES],
  [BusinessType.RETAIL]: [...SHARED_CORE_MODULES, ...RETAIL_MODULES],
  [BusinessType.RESTAURANT]: [...SHARED_CORE_MODULES, ...RESTAURANT_MODULES],
  [BusinessType.CAFE]: [...SHARED_CORE_MODULES, ...RESTAURANT_MODULES],
  [BusinessType.BAKERY]: [...SHARED_CORE_MODULES, ...RESTAURANT_MODULES],
  [BusinessType.GENERAL]: [...SHARED_CORE_MODULES],
};

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
