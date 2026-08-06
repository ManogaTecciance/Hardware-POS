/**
 * The inventory/accounting pair a newly created tenant of each business type gets
 * (Slice 8.9).
 *
 * ## Why this lives in the database package
 *
 * Two callers need it and neither can import from the API: `prisma/seed.ts` and
 * `prisma/provision-tenant.ts`. Writing the pair inline in both would put the
 * question "what does a new restaurant run on?" in two places that nothing checks
 * against each other, and the failure mode is a provisioned tenant whose profile
 * combination the API refuses to accept.
 *
 * ## Which side is authoritative
 *
 * `apps/api/src/modules/platform/profile-combinations.ts` is. This table is a
 * *selection* from that allow-list, never an extension of it: a pair here that the
 * API does not support would produce a tenant the platform cannot serve. An API
 * spec enumerates this map and fails if any entry falls outside the allow-list —
 * which is the only reason it is safe to state the pairs twice.
 *
 * `TILE_SHOP` keeps the QuickBooks pair because that is what every existing tenant
 * runs and what a tenant with no profile row resolves to. Provisioning a tile shop
 * must not quietly hand it a different configuration from the ones already live.
 */
import type { AccountingProviderKind, BusinessType, InventoryMode } from '@prisma/client';

export interface BusinessProfilePreset {
  inventoryMode: InventoryMode;
  accountingProvider: AccountingProviderKind;
}

/** Total over `BusinessType`: a type added to the enum fails the build here. */
export const BUSINESS_PROFILE_PRESETS: Record<BusinessType, BusinessProfilePreset> = {
  TILE_SHOP: { inventoryMode: 'QUICKBOOKS', accountingProvider: 'QUICKBOOKS' },
  HARDWARE: { inventoryMode: 'QUICKBOOKS', accountingProvider: 'QUICKBOOKS' },
  RETAIL: { inventoryMode: 'QUICKBOOKS', accountingProvider: 'QUICKBOOKS' },
  RESTAURANT: { inventoryMode: 'LOCAL', accountingProvider: 'NONE' },
  CAFE: { inventoryMode: 'LOCAL', accountingProvider: 'NONE' },
  BAKERY: { inventoryMode: 'LOCAL', accountingProvider: 'NONE' },
  // A catalogue without stock tracking — the third supported pair.
  GENERAL: { inventoryMode: 'DISABLED', accountingProvider: 'NONE' },
};

export const BUSINESS_TYPES = Object.keys(BUSINESS_PROFILE_PRESETS) as BusinessType[];
