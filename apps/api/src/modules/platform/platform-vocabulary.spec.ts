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

  it('D57: the removed business types are gone from BOTH sides', () => {
    // The consolidation is only done when neither side can express the old
    // values — one side alone would reintroduce the drift this spec ends.
    for (const removed of ['TILE_SHOP', 'RETAIL']) {
      expect(Object.values(BusinessType)).not.toContain(removed);
      expect(BUSINESS_TYPE_VALUES).not.toContain(removed);
    }
    // POSITIVE CONTROL: the check can fail — a value that IS present is found.
    expect(Object.values(BusinessType)).toContain('HARDWARE');
    expect(BUSINESS_TYPE_VALUES).toContain('HARDWARE');
  });
});
