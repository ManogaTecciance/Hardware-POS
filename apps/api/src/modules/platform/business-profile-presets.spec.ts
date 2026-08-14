import {
  AccountingProviderKind,
  BUSINESS_PROFILE_PRESETS,
  BUSINESS_TYPES,
  BusinessType,
  InventoryMode,
} from '@hardware-pos/database';

import {
  isSupportedProfileCombination,
  SUPPORTED_PROFILE_COMBINATIONS,
} from './profile-combinations';

/**
 * The provisioning presets are a subset of what this service accepts (Slice 8.9).
 *
 * `BUSINESS_PROFILE_PRESETS` lives in `packages/database` because `seed.ts` and
 * `provision-tenant.ts` need it and neither can import from the API. That is a
 * second statement of which inventory/accounting pairs are legitimate, and the
 * only thing that makes it safe is this spec: a preset outside the allow-list
 * produces a tenant whose profile the API refuses — a company provisioned into a
 * state the platform cannot serve, discovered by its owner at first login.
 */
describe('business profile presets', () => {
  it('covers every business type', () => {
    // A `Record<BusinessType, …>` catches an addition at compile time, but only
    // where the file is compiled. Assert the runtime set too, so a type added to
    // the enum and defaulted somewhere cannot slip through silently.
    expect([...BUSINESS_TYPES].sort()).toEqual(Object.values(BusinessType).sort());
    expect(BUSINESS_TYPES.length).toBeGreaterThan(0);
  });

  it('proposes only combinations the platform supports', () => {
    const rejected = BUSINESS_TYPES.filter((type) => {
      const preset = BUSINESS_PROFILE_PRESETS[type];
      return !isSupportedProfileCombination(preset.inventoryMode, preset.accountingProvider);
    });

    expect(rejected).toEqual([]);
  });

  it('keeps retail on the legacy QuickBooks pair', () => {
    // Provisioning a hardware tenant must produce the configuration the pilot
    // already runs, not a new one (D16). D57 renamed the value from TILE_SHOP;
    // the pair is unchanged.
    expect(BUSINESS_PROFILE_PRESETS[BusinessType.HARDWARE]).toEqual({
      inventoryMode: InventoryMode.QUICKBOOKS,
      accountingProvider: AccountingProviderKind.QUICKBOOKS,
    });
  });

  it('puts food service on local inventory with no accounting', () => {
    for (const type of [BusinessType.RESTAURANT, BusinessType.CAFE, BusinessType.BAKERY]) {
      expect({ type, preset: BUSINESS_PROFILE_PRESETS[type] }).toEqual({
        type,
        preset: {
          inventoryMode: InventoryMode.LOCAL,
          accountingProvider: AccountingProviderKind.NONE,
        },
      });
    }
  });

  it('does not give every type the same answer', () => {
    // The negative that makes the two above mean something: a table that returned
    // one pair for everything would satisfy the subset check completely.
    const distinct = new Set(
      BUSINESS_TYPES.map((type) => JSON.stringify(BUSINESS_PROFILE_PRESETS[type])),
    );
    expect(distinct.size).toBeGreaterThan(1);
  });

  describe('the subset assertion can actually fail', () => {
    it('detects a preset outside the allow-list', () => {
      // The exact mistake: QuickBooks accounting on a locally-mastered catalogue,
      // which posts sale lines with no `quickbooksItemId` to reference.
      const unsupported = {
        inventoryMode: InventoryMode.LOCAL,
        accountingProvider: AccountingProviderKind.QUICKBOOKS,
      };

      expect(
        isSupportedProfileCombination(unsupported.inventoryMode, unsupported.accountingProvider),
      ).toBe(false);
      expect(() => expect([unsupported]).toEqual([])).toThrow();
    });

    it('is checking against a non-empty allow-list', () => {
      // An empty `SUPPORTED_PROFILE_COMBINATIONS` would make every preset fail,
      // not pass — but an empty `BUSINESS_TYPES` would make the subset check
      // vacuous, and both are worth ruling out here.
      expect(SUPPORTED_PROFILE_COMBINATIONS.length).toBeGreaterThan(0);
      expect(BUSINESS_TYPES.length).toBe(Object.values(BusinessType).length);
    });
  });
});
