import { AccountingProviderKind, InventoryMode } from '@hardware-pos/database';

/**
 * The inventory/accounting pairs Phase 1 actually supports.
 *
 * Stated as data rather than as conditionals so the list is the specification, and
 * so a test can enumerate the whole `InventoryMode × AccountingProviderKind` space
 * and assert that everything outside this set is refused — rather than checking the
 * handful of pairs someone remembered to write a test for.
 */
export const SUPPORTED_PROFILE_COMBINATIONS: readonly {
  inventoryMode: InventoryMode;
  accountingProvider: AccountingProviderKind;
}[] = [
  // Today's Tile Shop, and what a legacy tenant resolves to.
  { inventoryMode: InventoryMode.QUICKBOOKS, accountingProvider: AccountingProviderKind.QUICKBOOKS },
  // A restaurant running entirely on AxloPOS.
  { inventoryMode: InventoryMode.LOCAL, accountingProvider: AccountingProviderKind.NONE },
  // A service business with a catalogue but no stock tracking.
  { inventoryMode: InventoryMode.DISABLED, accountingProvider: AccountingProviderKind.NONE },
];

/** Human-readable list for the error message. Order matches the array above. */
export const SUPPORTED_COMBINATION_LABELS: readonly string[] =
  SUPPORTED_PROFILE_COMBINATIONS.map(
    (combo) => `${combo.inventoryMode} inventory + ${combo.accountingProvider} accounting`,
  );

/**
 * Is this pair supported?
 *
 * Everything not listed is unsupported, deliberately — an allow-list, not a
 * deny-list, so a mode or provider added to either enum is refused until someone
 * decides what it pairs with. The notable rejections and why:
 *
 *  • **`LOCAL`/`DISABLED` inventory + `QUICKBOOKS` accounting.** QuickBooks sale and
 *    return documents reference `quickbooksItemId` per line, and nothing maintains
 *    those ids when AxloPOS owns the catalogue. Lines would post unattributed, and
 *    inventory items may be rejected outright.
 *  • **`QUICKBOOKS` inventory + `NONE` accounting.** Stock would be mastered in
 *    QuickBooks while its financial documents were not — the product pull would keep
 *    overwriting quantities for sales QuickBooks has no record of.
 *  • **`EXTERNAL` inventory / `FUTURE_EXTERNAL` accounting.** No implementation
 *    exists; both factories already fail closed, and this stops the row being
 *    written in the first place.
 */
export function isSupportedProfileCombination(
  inventoryMode: InventoryMode,
  accountingProvider: AccountingProviderKind,
): boolean {
  return SUPPORTED_PROFILE_COMBINATIONS.some(
    (combo) =>
      combo.inventoryMode === inventoryMode && combo.accountingProvider === accountingProvider,
  );
}
