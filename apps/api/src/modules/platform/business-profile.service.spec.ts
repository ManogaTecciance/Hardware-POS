import {
  AccountingProviderKind,
  BusinessType,
  InventoryMode,
  ModuleKey,
  TenantBusinessProfile,
  TenantModule,
} from '@hardware-pos/database';

import { BusinessProfileRepository, PersistedProfile } from './business-profile.repository';
import { BusinessProfileService } from './business-profile.service';
import { LEGACY_TENANT_DEFAULTS } from './platform.constants';

/**
 * Resolution rules, isolated from the database.
 *
 * `platform-profile.spec.ts` proves the same behaviour against real PostgreSQL;
 * this pins the precedence logic directly, where every combination of "row
 * present / absent" and "module stated / unstated" can be enumerated cheaply.
 */
describe('BusinessProfileService (resolution)', () => {
  const NOW = new Date('2026-08-04T10:00:00.000Z');

  function profileRow(overrides: Partial<TenantBusinessProfile> = {}): TenantBusinessProfile {
    return {
      id: 'prf_1',
      tenantId: 'tnt_a',
      businessType: BusinessType.RESTAURANT,
      inventoryMode: InventoryMode.LOCAL,
      accountingProvider: AccountingProviderKind.NONE,
      version: 3,
      createdAt: NOW,
      updatedAt: NOW,
      ...overrides,
    };
  }

  function moduleRow(moduleKey: ModuleKey, isEnabled: boolean): TenantModule {
    return {
      id: `mod_${moduleKey}`,
      tenantId: 'tnt_a',
      moduleKey,
      isEnabled,
      createdAt: NOW,
      updatedAt: NOW,
    };
  }

  function build(persisted: PersistedProfile): BusinessProfileService {
    const repository = {
      findByTenant: jest.fn().mockResolvedValue(persisted),
    } as unknown as BusinessProfileRepository;
    return new BusinessProfileService(repository);
  }

  describe('no profile row', () => {
    const persisted: PersistedProfile = { profile: null, modules: [] };

    it('resolves the legacy Tile Shop configuration', async () => {
      const effective = await build(persisted).getEffectiveProfile('tnt_a');

      expect(effective.source).toBe('LEGACY_DEFAULT');
      expect(effective.businessType).toBe(BusinessType.TILE_SHOP);
      expect(effective.inventoryMode).toBe(InventoryMode.QUICKBOOKS);
      expect(effective.accountingProvider).toBe(AccountingProviderKind.QUICKBOOKS);
      expect([...effective.enabledModules].sort()).toEqual(
        [...LEGACY_TENANT_DEFAULTS.enabledModules].sort(),
      );
    });

    it('reports no version or timestamp — there is no row to version', async () => {
      const effective = await build(persisted).getEffectiveProfile('tnt_a');
      expect(effective.version).toBeNull();
      expect(effective.updatedAt).toBeNull();
    });
  });

  describe('an explicit profile row', () => {
    it('reports the stored values and its version', async () => {
      const effective = await build({ profile: profileRow(), modules: [] }).getEffectiveProfile(
        'tnt_a',
      );

      expect(effective.source).toBe('EXPLICIT');
      expect(effective.businessType).toBe(BusinessType.RESTAURANT);
      expect(effective.inventoryMode).toBe(InventoryMode.LOCAL);
      expect(effective.accountingProvider).toBe(AccountingProviderKind.NONE);
      expect(effective.version).toBe(3);
    });

    it('falls back to the business-type defaults when no module row exists', async () => {
      const effective = await build({ profile: profileRow(), modules: [] }).getEffectiveProfile(
        'tnt_a',
      );

      expect(effective.enabledModules).toContain(ModuleKey.DINING);
      expect(effective.enabledModules).toContain(ModuleKey.MENU_MANAGEMENT);
      expect(effective.enabledModules).not.toContain(ModuleKey.QUOTATIONS);
    });
  });

  describe('explicit module rows win over the business-type default', () => {
    it('an explicit false REVOKES a module the default would enable', async () => {
      const effective = await build({
        profile: profileRow(),
        modules: [moduleRow(ModuleKey.DINING, false)],
      }).getEffectiveProfile('tnt_a');

      // The whole point of the model: a revocation must not be overridden by the
      // default set, or turning a feature off would be impossible.
      expect(effective.enabledModules).not.toContain(ModuleKey.DINING);
    });

    it('an explicit true GRANTS a module the default would not enable', async () => {
      const effective = await build({
        profile: profileRow(),
        modules: [moduleRow(ModuleKey.ONLINE_ORDERS, true)],
      }).getEffectiveProfile('tnt_a');

      expect(effective.enabledModules).toContain(ModuleKey.ONLINE_ORDERS);
    });

    it('leaves unstated modules on their default', async () => {
      const effective = await build({
        profile: profileRow(),
        modules: [moduleRow(ModuleKey.DINING, false)],
      }).getEffectiveProfile('tnt_a');

      expect(effective.enabledModules).toContain(ModuleKey.TAKEAWAY);
    });

    it('returns modules in enum declaration order', async () => {
      const effective = await build({
        profile: profileRow(),
        modules: [moduleRow(ModuleKey.ONLINE_ORDERS, true)],
      }).getEffectiveProfile('tnt_a');

      const positions = effective.enabledModules.map((key) => Object.values(ModuleKey).indexOf(key));
      expect(positions).toEqual([...positions].sort((a, b) => a - b));
    });
  });

  describe('isModuleEnabled', () => {
    it('is true for a legacy tenant asking about a retail module', async () => {
      const service = build({ profile: null, modules: [] });
      await expect(service.isModuleEnabled('tnt_a', ModuleKey.QUOTATIONS)).resolves.toBe(true);
    });

    it('is false for a legacy tenant asking about a restaurant module', async () => {
      const service = build({ profile: null, modules: [] });
      await expect(service.isModuleEnabled('tnt_a', ModuleKey.DINING)).resolves.toBe(false);
    });

    it('is false for a restaurant tenant asking about quotations', async () => {
      const service = build({ profile: profileRow(), modules: [] });
      await expect(service.isModuleEnabled('tnt_a', ModuleKey.QUOTATIONS)).resolves.toBe(false);
    });
  });

  describe('getModuleStates', () => {
    it('distinguishes an explicitly disabled module from one that is simply off', async () => {
      const states = await build({
        profile: profileRow(),
        modules: [moduleRow(ModuleKey.DINING, false)],
      }).getModuleStates('tnt_a');

      const dining = states.find((s) => s.moduleKey === ModuleKey.DINING);
      expect(dining).toEqual({ moduleKey: ModuleKey.DINING, isEnabled: false, isExplicit: true });

      // Never configured and not a restaurant default → omitted entirely rather
      // than listed as a wall of `false`. RESERVATIONS became a food-service
      // default in D47, so the Release-2 opt-ins carry the assertion now.
      expect(states.map((s) => s.moduleKey)).not.toContain(ModuleKey.ONLINE_ORDERS);
    });

    it('marks default-derived modules as not explicit', async () => {
      const states = await build({ profile: profileRow(), modules: [] }).getModuleStates('tnt_a');

      const takeaway = states.find((s) => s.moduleKey === ModuleKey.TAKEAWAY);
      expect(takeaway).toEqual({ moduleKey: ModuleKey.TAKEAWAY, isEnabled: true, isExplicit: false });
    });
  });
});
