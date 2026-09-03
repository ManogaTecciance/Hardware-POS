/**
 * Human wording for the platform-profile enums (Slice 8.7).
 *
 * Every map is a total `Record` over its union rather than a lookup with a
 * fallback. A module added to `ModuleKey` and forgotten here fails the build,
 * which is the only reliable moment to notice — the alternative is a settings
 * screen quietly printing `DELIVERY_INTEGRATIONS` at an operator.
 */
import type {
  AccountingProviderKind,
  BusinessType,
  InventoryMode,
  ModuleKey,
} from './platform-api';
import { BUSINESS_TYPE_VALUES, domainFor } from '@hardware-pos/shared';

/**
 * D56: labels come from the domain registry — one declaration, shared with the
 * API and the console. A business type without a label is a compile error in
 * the registry, not a blank cell here.
 */
export const BUSINESS_TYPE_LABELS: Record<BusinessType, string> = Object.fromEntries(
  BUSINESS_TYPE_VALUES.map((t) => [t, domainFor(t).label]),
) as Record<BusinessType, string>;

/** Phrased as *where stock is mastered*, which is what the mode actually decides. */
export const INVENTORY_MODE_LABELS: Record<InventoryMode, string> = {
  LOCAL: 'Tracked in AxloPOS',
  QUICKBOOKS: 'Tracked in QuickBooks Online',
  EXTERNAL: 'Tracked in an external system',
  DISABLED: 'Not tracked',
};

export const ACCOUNTING_PROVIDER_LABELS: Record<AccountingProviderKind, string> = {
  NONE: 'None',
  QUICKBOOKS: 'QuickBooks Online',
  FUTURE_EXTERNAL: 'External accounting system',
};

export const MODULE_LABELS: Record<ModuleKey, string> = {
  RETAIL_POS: 'Point of sale',
  INVENTORY: 'Inventory',
  CUSTOMERS: 'Customers',
  QUOTATIONS: 'Quotations',
  RETURNS: 'Returns',
  EXCHANGES: 'Exchanges',
  SUPPLIERS: 'Suppliers',
  // D103 — its own module key, carried by retail and food service alike.
  PROMOTIONS: 'Promotions',
  REPORTING: 'Reports',
  USERS: 'Users and roles',
  BRANCHES: 'Branches',
  SETTINGS: 'Settings',
  BRANDING: 'Branding',
  QUICKBOOKS: 'QuickBooks',
  MENU_MANAGEMENT: 'Menu',
  DINING: 'Dining areas',
  TABLE_MANAGEMENT: 'Tables',
  TAKEAWAY: 'Takeaway',
  KITCHEN: 'Kitchen',
  KITCHEN_DISPLAY: 'Kitchen display',
  ONLINE_ORDERS: 'Online orders',
  DELIVERY_INTEGRATIONS: 'Delivery integrations',
  RESERVATIONS: 'Reservations',
};

/**
 * Display order for a module list — declaration order of `MODULE_LABELS`, which
 * mirrors `ALL_MODULE_KEYS` on the server.
 *
 * The API returns modules in that order already; sorting here means the screen
 * does not depend on it, and a reordered response is not a visible change.
 */
export function sortModules(modules: readonly ModuleKey[]): ModuleKey[] {
  const wanted = new Set(modules);
  return (Object.keys(MODULE_LABELS) as ModuleKey[]).filter((key) => wanted.has(key));
}
