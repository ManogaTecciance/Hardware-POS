/**
 * Module bundles the descriptors compose from (moved here from
 * `apps/api/src/modules/platform/platform.constants.ts` under D56 so a
 * descriptor can declare its module set without importing the API).
 *
 * `PAYMENTS` appears in no set because it is not a module key: payment
 * collection is core to every profile and must never be switchable off.
 */
import type { ModuleKey } from '../types/platform.js';

/** Modules every business profile gets — the shared AxloPOS core. */
export const SHARED_CORE_MODULES: readonly ModuleKey[] = [
  'CUSTOMERS',
  'REPORTING',
  'USERS',
  'BRANCHES',
  'SETTINGS',
  'BRANDING',
];

/** Retail/trade modules, on top of the shared core. */
export const RETAIL_MODULES: readonly ModuleKey[] = [
  'RETAIL_POS',
  'INVENTORY',
  'QUOTATIONS',
  'RETURNS',
  'EXCHANGES',
  'SUPPLIERS',
  'QUICKBOOKS',
];

/**
 * Food-service modules, on top of the shared core.
 *
 * Deliberately excludes `QUOTATIONS`, `RETURNS`, `SUPPLIERS`, `QUICKBOOKS`,
 * and `EXCHANGES` (decision D2). `KITCHEN_DISPLAY`, `ONLINE_ORDERS`, and
 * `DELIVERY_INTEGRATIONS` are opt-in rather than default, matching the
 * Release 1 / Release 2 boundary. `RESERVATIONS` moved from opt-in to the
 * default set when the reservation calendar shipped (D47).
 */
export const FOOD_SERVICE_MODULES: readonly ModuleKey[] = [
  'MENU_MANAGEMENT',
  'DINING',
  'TABLE_MANAGEMENT',
  'TAKEAWAY',
  'KITCHEN',
  'RESERVATIONS',
];
