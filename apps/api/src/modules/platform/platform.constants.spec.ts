import { AccountingProviderKind, BusinessType, InventoryMode, ModuleKey } from '@hardware-pos/database';

import {
  ALL_MODULE_KEYS,
  DEFAULT_MODULES_BY_BUSINESS_TYPE,
  LEGACY_TENANT_DEFAULTS,
  sortModules,
} from './platform.constants';

/**
 * These are compatibility assertions, not descriptions of an implementation.
 *
 * `LEGACY_TENANT_DEFAULTS` is what every tenant in the production database
 * resolves to, because none of them has a `TenantBusinessProfile` row. Changing a
 * value here changes live Tile Shop behaviour, so each one is pinned explicitly
 * and a change has to be a deliberate edit to this file.
 */
describe('platform constants', () => {
  describe('legacy defaults preserve current Tile Shop behaviour', () => {
    it('is a QuickBooks-mastered tile shop', () => {
      expect(LEGACY_TENANT_DEFAULTS.businessType).toBe(BusinessType.TILE_SHOP);
      expect(LEGACY_TENANT_DEFAULTS.inventoryMode).toBe(InventoryMode.QUICKBOOKS);
      expect(LEGACY_TENANT_DEFAULTS.accountingProvider).toBe(AccountingProviderKind.QUICKBOOKS);
    });

    it('enables exactly the modules the current product ships', () => {
      expect([...LEGACY_TENANT_DEFAULTS.enabledModules].sort()).toEqual(
        [
          ModuleKey.BRANCHES,
          ModuleKey.BRANDING,
          ModuleKey.CUSTOMERS,
          ModuleKey.EXCHANGES,
          ModuleKey.INVENTORY,
          ModuleKey.QUICKBOOKS,
          ModuleKey.QUOTATIONS,
          ModuleKey.REPORTING,
          ModuleKey.RETAIL_POS,
          ModuleKey.RETURNS,
          ModuleKey.SETTINGS,
          ModuleKey.SUPPLIERS,
          ModuleKey.USERS,
        ].sort(),
      );
    });

    it.each([
      ['quotations', ModuleKey.QUOTATIONS],
      ['returns', ModuleKey.RETURNS],
      ['exchange document rendering', ModuleKey.EXCHANGES],
      ['suppliers', ModuleKey.SUPPLIERS],
      ['customers', ModuleKey.CUSTOMERS],
      ['reports', ModuleKey.REPORTING],
      ['users', ModuleKey.USERS],
      ['branches', ModuleKey.BRANCHES],
      ['settings', ModuleKey.SETTINGS],
      ['branding', ModuleKey.BRANDING],
      ['inventory', ModuleKey.INVENTORY],
      ['the retail POS', ModuleKey.RETAIL_POS],
      ['QuickBooks', ModuleKey.QUICKBOOKS],
    ])('keeps %s available', (_label, moduleKey) => {
      expect(LEGACY_TENANT_DEFAULTS.enabledModules).toContain(moduleKey);
    });
  });

  describe('PAYMENTS is not a module', () => {
    it('has no PAYMENTS key at all — payment collection is shared core', () => {
      expect(ALL_MODULE_KEYS).not.toContain('PAYMENTS' as ModuleKey);
      expect(Object.keys(ModuleKey)).not.toContain('PAYMENTS');
    });

    it('is absent from every business type default set', () => {
      for (const modules of Object.values(DEFAULT_MODULES_BY_BUSINESS_TYPE)) {
        expect(modules).not.toContain('PAYMENTS' as ModuleKey);
      }
    });
  });

  describe('default module sets by business type', () => {
    it('gives every business type the shared core', () => {
      const core = [
        ModuleKey.CUSTOMERS,
        ModuleKey.REPORTING,
        ModuleKey.USERS,
        ModuleKey.BRANCHES,
        ModuleKey.SETTINGS,
        ModuleKey.BRANDING,
      ];
      for (const businessType of Object.values(BusinessType)) {
        expect(DEFAULT_MODULES_BY_BUSINESS_TYPE[businessType]).toEqual(
          expect.arrayContaining(core),
        );
      }
    });

    it.each([BusinessType.TILE_SHOP, BusinessType.HARDWARE, BusinessType.RETAIL])(
      '%s matches the legacy retail set exactly',
      (businessType) => {
        expect([...DEFAULT_MODULES_BY_BUSINESS_TYPE[businessType]].sort()).toEqual(
          [...LEGACY_TENANT_DEFAULTS.enabledModules].sort(),
        );
      },
    );

    it.each([BusinessType.RESTAURANT, BusinessType.CAFE, BusinessType.BAKERY])(
      '%s gets the restaurant modules',
      (businessType) => {
        expect(DEFAULT_MODULES_BY_BUSINESS_TYPE[businessType]).toEqual(
          expect.arrayContaining([
            ModuleKey.MENU_MANAGEMENT,
            ModuleKey.DINING,
            ModuleKey.TABLE_MANAGEMENT,
            ModuleKey.TAKEAWAY,
            ModuleKey.KITCHEN,
          ]),
        );
      },
    );

    it.each([
      ['QUOTATIONS', ModuleKey.QUOTATIONS],
      ['RETURNS', ModuleKey.RETURNS],
      ['SUPPLIERS', ModuleKey.SUPPLIERS],
      ['QUICKBOOKS', ModuleKey.QUICKBOOKS],
      // Decision D2: Exchanges stay a Tile Shop / Hardware feature.
      ['EXCHANGES', ModuleKey.EXCHANGES],
    ])('a RESTAURANT does not get %s by default', (_label, moduleKey) => {
      expect(DEFAULT_MODULES_BY_BUSINESS_TYPE[BusinessType.RESTAURANT]).not.toContain(moduleKey);
    });

    it.each([
      ['KITCHEN_DISPLAY', ModuleKey.KITCHEN_DISPLAY],
      ['ONLINE_ORDERS', ModuleKey.ONLINE_ORDERS],
      ['DELIVERY_INTEGRATIONS', ModuleKey.DELIVERY_INTEGRATIONS],
    ])('keeps %s opt-in rather than default (Release 2 boundary)', (_label, moduleKey) => {
      expect(DEFAULT_MODULES_BY_BUSINESS_TYPE[BusinessType.RESTAURANT]).not.toContain(moduleKey);
    });

    // D47 moved RESERVATIONS across the Release 1 / Release 2 boundary: the
    // reservation calendar ships with the pilot, so food-service tenants get
    // the module without a per-tenant opt-in.
    it('RESERVATIONS is a food-service default since D47', () => {
      expect(DEFAULT_MODULES_BY_BUSINESS_TYPE[BusinessType.RESTAURANT]).toContain(ModuleKey.RESERVATIONS);
      expect(DEFAULT_MODULES_BY_BUSINESS_TYPE[BusinessType.CAFE]).toContain(ModuleKey.RESERVATIONS);
      expect(DEFAULT_MODULES_BY_BUSINESS_TYPE[BusinessType.HARDWARE]).not.toContain(ModuleKey.RESERVATIONS);
      expect(DEFAULT_MODULES_BY_BUSINESS_TYPE[BusinessType.TILE_SHOP]).not.toContain(ModuleKey.RESERVATIONS);
    });

    it('GENERAL gets only the shared core', () => {
      expect(DEFAULT_MODULES_BY_BUSINESS_TYPE[BusinessType.GENERAL]).toHaveLength(6);
    });

    it('covers every business type — a new enum member must be given a default set', () => {
      for (const businessType of Object.values(BusinessType)) {
        expect(DEFAULT_MODULES_BY_BUSINESS_TYPE[businessType]).toBeDefined();
      }
    });
  });

  describe('sortModules', () => {
    it('returns enum declaration order regardless of input order', () => {
      expect(sortModules([ModuleKey.QUICKBOOKS, ModuleKey.RETAIL_POS, ModuleKey.CUSTOMERS])).toEqual(
        [ModuleKey.RETAIL_POS, ModuleKey.CUSTOMERS, ModuleKey.QUICKBOOKS],
      );
    });

    it('de-duplicates', () => {
      expect(sortModules([ModuleKey.DINING, ModuleKey.DINING])).toEqual([ModuleKey.DINING]);
    });
  });
});
