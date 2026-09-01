/**
 * Platform vocabulary — the single authority for the business-type and module
 * unions (convergence plan Phase 0, D56/D57).
 *
 * ## Why these live here and not in two places
 *
 * The web client must never import `@hardware-pos/database` (the Prisma client
 * cannot reach a browser bundle), so it used to hand-maintain string-literal
 * copies of these unions in `apps/web/src/lib/platform-api.ts`, guarded by a
 * regex that parsed the file as text — a guard that broke twice during D55
 * when a comment landed inside the union. This package is browser-safe by
 * design, so the unions live here once; the web imports them, and an API-side
 * contract spec compares these values against the Prisma enums **at runtime**,
 * in both directions, with no regex involved.
 *
 * ## The `as const` array + derived union pattern
 *
 * Each vocabulary is declared as a readonly array with the type derived from
 * it, so the runtime values and the compile-time union cannot drift — there is
 * nothing to keep in sync.
 */

/**
 * What kind of business a tenant runs. Drives the domain registry
 * (`domainFor`), never the correctness of a shared code path.
 *
 * D57: `TILE_SHOP` and `RETAIL` are gone. The pilot tile shop *is* a
 * hardware-template business (PO decision, 2026-08-14), and `RETAIL` was a
 * speculative value nothing ever used. One value per workspace template.
 *
 * **D99 supersedes D57 on `RETAIL` only.** A clothing retailer is now in scope,
 * so the value returns — appended, matching the order
 * `ALTER TYPE … ADD VALUE` produces in the database. `TILE_SHOP` stays gone;
 * that finding was about an entity, not a template.
 *
 * This list is a hand-maintained mirror of the Prisma enum, not a derivation of
 * it — so a value added to `schema.prisma` must be added here too. The compiler
 * catches the omission the moment a descriptor references the new value, which
 * is how this one was caught.
 */
export const BUSINESS_TYPE_VALUES = [
  'HARDWARE',
  'RESTAURANT',
  'CAFE',
  'BAKERY',
  'HOTEL',
  'GENERAL',
  'RETAIL',
] as const;
export type BusinessType = (typeof BUSINESS_TYPE_VALUES)[number];

/** Where stock lives and who is authoritative for it. Mirrors the Prisma enum. */
export const INVENTORY_MODE_VALUES = ['LOCAL', 'QUICKBOOKS', 'EXTERNAL', 'DISABLED'] as const;
export type InventoryMode = (typeof INVENTORY_MODE_VALUES)[number];

/** Which accounting system receives completed documents. Mirrors the Prisma enum. */
export const ACCOUNTING_PROVIDER_KIND_VALUES = ['NONE', 'QUICKBOOKS', 'FUTURE_EXTERNAL'] as const;
export type AccountingProviderKind = (typeof ACCOUNTING_PROVIDER_KIND_VALUES)[number];

/**
 * Switchable feature modules. `PAYMENTS` is intentionally absent — taking
 * payment is core to every business profile and is never switchable off.
 */
export const MODULE_KEY_VALUES = [
  // Retail + shared
  'RETAIL_POS',
  'INVENTORY',
  'CUSTOMERS',
  'QUOTATIONS',
  'RETURNS',
  'EXCHANGES',
  'SUPPLIERS',
  'REPORTING',
  'USERS',
  'BRANCHES',
  'SETTINGS',
  'BRANDING',
  'QUICKBOOKS',
  // Restaurant
  'MENU_MANAGEMENT',
  'DINING',
  'TABLE_MANAGEMENT',
  'TAKEAWAY',
  'KITCHEN',
  'KITCHEN_DISPLAY',
  'ONLINE_ORDERS',
  'DELIVERY_INTEGRATIONS',
  'RESERVATIONS',
] as const;
export type ModuleKey = (typeof MODULE_KEY_VALUES)[number];
