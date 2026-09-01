/**
 * Drift guard between the persisted Prisma enums and the shared vocabulary
 * (D56 — replaces `module-key-contract.spec.ts`).
 *
 * The web client must never import the Prisma client, so it used to
 * hand-maintain string-literal unions guarded by a REGEX over the web file's
 * source text — a guard that broke twice during D55 when a comment landed
 * inside a union. D56 moved the unions to `@hardware-pos/shared` (browser-safe
 * by design); the web imports them, and this spec compares the shared VALUES
 * against the Prisma enums at runtime. No parsing, nothing to drift out of
 * match with the file it reads.
 *
 * Both directions matter: a value added to Prisma and not to shared would hide
 * a real tenant state from every client; a value added to shared and not to
 * Prisma would let a client offer a state the API rejects.
 */
import {
  AccountingProviderKind,
  BusinessType,
  InventoryMode,
  ModuleKey,
} from '@hardware-pos/database';
import {
  ACCOUNTING_PROVIDER_KIND_VALUES,
  BUSINESS_TYPE_VALUES,
  INVENTORY_MODE_VALUES,
  MODULE_KEY_VALUES,
} from '@hardware-pos/shared';

describe('shared vocabulary mirrors the persisted enums, both ways', () => {
  it.each([
    ['BusinessType', BusinessType, BUSINESS_TYPE_VALUES],
    ['InventoryMode', InventoryMode, INVENTORY_MODE_VALUES],
    ['AccountingProviderKind', AccountingProviderKind, ACCOUNTING_PROVIDER_KIND_VALUES],
    ['ModuleKey', ModuleKey, MODULE_KEY_VALUES],
  ] as const)('%s', (_name, prismaEnum, sharedValues) => {
    expect([...sharedValues].sort()).toEqual(
      Object.values(prismaEnum as Record<string, string>).sort(),
    );
  });

  it('the shared module vocabulary does not offer PAYMENTS', () => {
    // Payment collection is core to every profile and never switchable off.
    expect(MODULE_KEY_VALUES).not.toContain('PAYMENTS');
  });

  it('D57: TILE_SHOP is gone from BOTH sides', () => {
    // The consolidation is only done when neither side can express the old
    // value — one side alone would reintroduce the drift this spec ends.
    //
    // `RETAIL` used to be asserted here too. **D99 supersedes D57 on that value
    // only**: a clothing retailer is now in scope, so the template returned and
    // the value with it. The TILE_SHOP finding is untouched — it was about an
    // entity (the pilot tile shop really is a HARDWARE workspace), not about
    // whether a retail template should exist.
    expect(Object.values(BusinessType)).not.toContain('TILE_SHOP');
    expect(BUSINESS_TYPE_VALUES).not.toContain('TILE_SHOP');

    // POSITIVE CONTROL: the check can fail — a value that IS present is found.
    expect(Object.values(BusinessType)).toContain('HARDWARE');
    expect(BUSINESS_TYPE_VALUES).toContain('HARDWARE');
  });

  it('D99: RETAIL is back, on BOTH sides and in step', () => {
    // The mirror is hand-maintained, so the two can drift. Asserting both is
    // what makes adding a value to one of them a test failure rather than a
    // runtime surprise — which is how the shared union's omission was caught
    // when this migration landed.
    expect(Object.values(BusinessType)).toContain('RETAIL');
    expect(BUSINESS_TYPE_VALUES).toContain('RETAIL');
  });
});
