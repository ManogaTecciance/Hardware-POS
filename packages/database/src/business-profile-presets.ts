/**
 * The inventory/accounting pair a newly created tenant of each business type
 * gets.
 *
 * ## D56: derived from the domain registry, not restated
 *
 * The pairs are declared once, on each `DomainDescriptor` in
 * `@hardware-pos/shared` — the same declaration the API and the web read. This
 * module keeps its export shape because two callers need it here and neither
 * can import from the API: `prisma/seed.ts` and `prisma/provision-tenant.ts`.
 *
 * ## Which side is authoritative
 *
 * `apps/api/src/modules/platform/profile-combinations.ts` is. A descriptor's
 * pair is a *selection* from that allow-list, never an extension of it: a pair
 * the API does not support would produce a tenant the platform cannot serve.
 * An API spec enumerates this map against the allow-list, which is the only
 * reason it is safe to state the pairs at all.
 *
 * The cast from the shared string union to the Prisma enums is sound because
 * `platform-vocabulary.spec.ts` (D56) asserts the two vocabularies are equal
 * at runtime, in both directions.
 */
import type { AccountingProviderKind, BusinessType, InventoryMode } from '@prisma/client';
import { BUSINESS_TYPE_VALUES, domainFor } from '@hardware-pos/shared';

export interface BusinessProfilePreset {
  inventoryMode: InventoryMode;
  accountingProvider: AccountingProviderKind;
}

/** Total over `BusinessType`: a type added to the enum fails the build here. */
export const BUSINESS_PROFILE_PRESETS: Record<BusinessType, BusinessProfilePreset> =
  Object.fromEntries(
    BUSINESS_TYPE_VALUES.map((businessType) => {
      const { inventoryMode, accountingProvider } = domainFor(businessType).profile;
      return [
        businessType,
        {
          inventoryMode: inventoryMode as InventoryMode,
          accountingProvider: accountingProvider as AccountingProviderKind,
        },
      ];
    }),
  ) as Record<BusinessType, BusinessProfilePreset>;

export const BUSINESS_TYPES = Object.keys(BUSINESS_PROFILE_PRESETS) as BusinessType[];
