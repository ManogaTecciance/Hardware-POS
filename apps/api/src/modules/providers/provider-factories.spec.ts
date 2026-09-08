/**
 * Provider resolution, isolated from the database.
 *
 * The whole point of these tests is the *refusal* direction. A factory that
 * silently substitutes a provider is the worst failure mode in this layer: stock
 * moves in a system the tenant did not configure, or a tenant's sales quietly never
 * reach their books — and both look exactly like normal operation until someone
 * reconciles months later. So every unsupported and unknown value is asserted to
 * throw, and asserted *not* to return one of the working providers.
 */

import { domainFor } from '@hardware-pos/shared';
import { AccountingProviderKind, BusinessType, InventoryMode } from '@hardware-pos/database';

import { BusinessProfileService } from '../platform/business-profile.service';
import { LEGACY_TENANT_DEFAULTS } from '../platform/platform.constants';
import type { EffectiveBusinessProfile } from '../platform/platform.types';
import { AccountingProviderFactory } from './accounting/accounting-provider.factory';
import { NoAccountingProvider } from './accounting/no-accounting.provider';
import { QuickBooksAccountingProvider } from './accounting/quickbooks-accounting.provider';
import { InventoryProviderFactory } from './inventory/inventory-provider.factory';
import { LocalInventoryProvider } from './inventory/local-inventory.provider';
import { NoInventoryProvider } from './inventory/no-inventory.provider';
import { QuickBooksInventoryProvider } from './inventory/quickbooks-inventory.provider';
import {
  ProviderError,
  ProviderErrorCode,
  UnsupportedAccountingProviderError,
  UnsupportedInventoryProviderError,
} from './provider.errors';

const LEGACY_PROFILE: EffectiveBusinessProfile = {
  source: 'LEGACY_DEFAULT',
  businessType: LEGACY_TENANT_DEFAULTS.businessType,
  capabilities: domainFor(LEGACY_TENANT_DEFAULTS.businessType).capabilities,
  inventoryMode: LEGACY_TENANT_DEFAULTS.inventoryMode,
  accountingProvider: LEGACY_TENANT_DEFAULTS.accountingProvider,
  enabledModules: [...LEGACY_TENANT_DEFAULTS.enabledModules],
  version: null,
  updatedAt: null,
};

function profile(overrides: Partial<EffectiveBusinessProfile> = {}): EffectiveBusinessProfile {
  return { ...LEGACY_PROFILE, source: 'EXPLICIT', version: 1, ...overrides };
}

/** Stand-ins: resolution must never touch a provider's behaviour, only its identity. */
const quickBooksInventory = { mode: InventoryMode.QUICKBOOKS } as QuickBooksInventoryProvider;
const localInventory = { mode: InventoryMode.LOCAL } as LocalInventoryProvider;
const noInventory = { mode: InventoryMode.DISABLED } as NoInventoryProvider;
const quickBooksAccounting = {
  provider: AccountingProviderKind.QUICKBOOKS,
} as QuickBooksAccountingProvider;
const noAccounting = { provider: AccountingProviderKind.NONE } as NoAccountingProvider;

function buildInventory(effective: EffectiveBusinessProfile): {
  factory: InventoryProviderFactory;
  getEffectiveProfile: jest.Mock;
} {
  const getEffectiveProfile = jest.fn().mockResolvedValue(effective);
  const businessProfile = { getEffectiveProfile } as unknown as BusinessProfileService;
  return {
    factory: new InventoryProviderFactory(
      businessProfile,
      quickBooksInventory,
      localInventory,
      noInventory,
    ),
    getEffectiveProfile,
  };
}

function buildAccounting(effective: EffectiveBusinessProfile): {
  factory: AccountingProviderFactory;
  getEffectiveProfile: jest.Mock;
} {
  const getEffectiveProfile = jest.fn().mockResolvedValue(effective);
  const businessProfile = { getEffectiveProfile } as unknown as BusinessProfileService;
  return {
    factory: new AccountingProviderFactory(businessProfile, quickBooksAccounting, noAccounting),
    getEffectiveProfile,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1, 2 — legacy tenant
// ─────────────────────────────────────────────────────────────────────────────

describe('a legacy tenant with no explicit profile', () => {
  it('resolves the QuickBooks INVENTORY provider', async () => {
    const { factory } = buildInventory(LEGACY_PROFILE);
    await expect(factory.forTenant('tnt_legacy')).resolves.toBe(quickBooksInventory);
  });

  it('resolves the QuickBooks ACCOUNTING provider', async () => {
    const { factory } = buildAccounting(LEGACY_PROFILE);
    await expect(factory.forTenant('tnt_legacy')).resolves.toBe(quickBooksAccounting);
  });

  it('gets there through the profile service, not through its own legacy branch', async () => {
    const { factory, getEffectiveProfile } = buildInventory(LEGACY_PROFILE);
    await factory.forTenant('tnt_legacy');
    expect(getEffectiveProfile).toHaveBeenCalledWith('tnt_legacy');
    expect(getEffectiveProfile).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3-6, 22 — inventory resolution
// ─────────────────────────────────────────────────────────────────────────────

describe('inventory provider resolution', () => {
  it.each([
    [InventoryMode.QUICKBOOKS, quickBooksInventory],
    [InventoryMode.LOCAL, localInventory],
    [InventoryMode.DISABLED, noInventory],
  ])('%s resolves its provider', async (inventoryMode, expected) => {
    const { factory } = buildInventory(profile({ inventoryMode }));
    await expect(factory.forTenant('tnt_a')).resolves.toBe(expected);
  });

  it('EXTERNAL fails closed', async () => {
    const { factory } = buildInventory(profile({ inventoryMode: InventoryMode.EXTERNAL }));
    await expect(factory.forTenant('tnt_a')).rejects.toThrow(UnsupportedInventoryProviderError);
  });

  it('EXTERNAL never falls back to another provider', async () => {
    const { factory } = buildInventory(profile({ inventoryMode: InventoryMode.EXTERNAL }));
    const result = await factory.forTenant('tnt_a').catch((err: unknown) => err);

    expect(result).toBeInstanceOf(ProviderError);
    expect(result).not.toBe(quickBooksInventory);
    expect(result).not.toBe(localInventory);
    expect(result).not.toBe(noInventory);
  });

  it('EXTERNAL carries a machine-readable code and a 501', async () => {
    const { factory } = buildInventory(profile({ inventoryMode: InventoryMode.EXTERNAL }));
    const err = (await factory.forTenant('tnt_a').catch((e: unknown) => e)) as ProviderError;

    expect(err.code).toBe(ProviderErrorCode.UNSUPPORTED_INVENTORY_PROVIDER);
    expect(err.getStatus()).toBe(501);
  });

  it('an unknown mode fails safely rather than defaulting', () => {
    const { factory } = buildInventory(LEGACY_PROFILE);
    expect(() => factory.forMode('TELEPATHY' as InventoryMode)).toThrow(
      UnsupportedInventoryProviderError,
    );
  });

  it('covers every InventoryMode in the enum — a new one cannot be silently unhandled', () => {
    const { factory } = buildInventory(LEGACY_PROFILE);
    for (const mode of Object.values(InventoryMode)) {
      let outcome: unknown;
      try {
        outcome = factory.forMode(mode);
      } catch (err) {
        outcome = err;
      }
      // Either a provider or a typed refusal — never undefined, never a silent pass.
      expect(outcome).toBeDefined();
      if (!(outcome instanceof ProviderError)) {
        expect(outcome).toHaveProperty('mode', mode);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7-9, 22 — accounting resolution
// ─────────────────────────────────────────────────────────────────────────────

describe('accounting provider resolution', () => {
  it.each([
    [AccountingProviderKind.QUICKBOOKS, quickBooksAccounting],
    [AccountingProviderKind.NONE, noAccounting],
  ])('%s resolves its provider', async (accountingProvider, expected) => {
    const { factory } = buildAccounting(profile({ accountingProvider }));
    await expect(factory.forTenant('tnt_a')).resolves.toBe(expected);
  });

  it('FUTURE_EXTERNAL fails closed', async () => {
    const { factory } = buildAccounting(
      profile({ accountingProvider: AccountingProviderKind.FUTURE_EXTERNAL }),
    );
    await expect(factory.forTenant('tnt_a')).rejects.toThrow(UnsupportedAccountingProviderError);
  });

  it('FUTURE_EXTERNAL never silently becomes NoAccounting', async () => {
    // The dangerous fallback: a tenant expecting their books to be posted, whose
    // sales quietly go nowhere.
    const { factory } = buildAccounting(
      profile({ accountingProvider: AccountingProviderKind.FUTURE_EXTERNAL }),
    );
    const result = await factory.forTenant('tnt_a').catch((err: unknown) => err);

    expect(result).toBeInstanceOf(ProviderError);
    expect(result).not.toBe(noAccounting);
    expect(result).not.toBe(quickBooksAccounting);
  });

  it('FUTURE_EXTERNAL carries a machine-readable code and a 501', async () => {
    const { factory } = buildAccounting(
      profile({ accountingProvider: AccountingProviderKind.FUTURE_EXTERNAL }),
    );
    const err = (await factory.forTenant('tnt_a').catch((e: unknown) => e)) as ProviderError;

    expect(err.code).toBe(ProviderErrorCode.UNSUPPORTED_ACCOUNTING_PROVIDER);
    expect(err.getStatus()).toBe(501);
  });

  it('an unknown provider fails safely', () => {
    const { factory } = buildAccounting(LEGACY_PROFILE);
    expect(() => factory.forProvider('SAGE' as AccountingProviderKind)).toThrow(
      UnsupportedAccountingProviderError,
    );
  });

  it('covers every AccountingProviderKind in the enum', () => {
    const { factory } = buildAccounting(LEGACY_PROFILE);
    for (const kind of Object.values(AccountingProviderKind)) {
      let outcome: unknown;
      try {
        outcome = factory.forProvider(kind);
      } catch (err) {
        outcome = err;
      }
      expect(outcome).toBeDefined();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 15, 16 — the factories use the authoritative service and duplicate nothing
// ─────────────────────────────────────────────────────────────────────────────

describe('the factories delegate resolution rather than reimplementing it', () => {
  it('a RESTAURANT/LOCAL/NONE profile resolves Local + NoAccounting', async () => {
    const restaurant = profile({
      businessType: BusinessType.RESTAURANT,
      inventoryMode: InventoryMode.LOCAL,
      accountingProvider: AccountingProviderKind.NONE,
    });

    await expect(buildInventory(restaurant).factory.forTenant('tnt_r')).resolves.toBe(
      localInventory,
    );
    await expect(buildAccounting(restaurant).factory.forTenant('tnt_r')).resolves.toBe(noAccounting);
  });

  it('reads the profile on EVERY call — no cross-request cache (decision D11)', async () => {
    const { factory, getEffectiveProfile } = buildInventory(LEGACY_PROFILE);

    await factory.forTenant('tnt_a');
    await factory.forTenant('tnt_a');
    await factory.forTenant('tnt_a');

    // Switching a tenant's inventory mode must take effect on the next call, not
    // after a TTL.
    expect(getEffectiveProfile).toHaveBeenCalledTimes(3);
  });

  it('ignores businessType entirely — only the modes decide', async () => {
    // A RESTAURANT that has (unusually) kept QuickBooks must still get the
    // QuickBooks providers. Deriving a provider from businessType would be a second
    // rule competing with the explicit mode.
    const oddball = profile({
      businessType: BusinessType.RESTAURANT,
      inventoryMode: InventoryMode.QUICKBOOKS,
      accountingProvider: AccountingProviderKind.QUICKBOOKS,
    });

    await expect(buildInventory(oddball).factory.forTenant('tnt_r')).resolves.toBe(
      quickBooksInventory,
    );
    await expect(buildAccounting(oddball).factory.forTenant('tnt_r')).resolves.toBe(
      quickBooksAccounting,
    );
  });
});
