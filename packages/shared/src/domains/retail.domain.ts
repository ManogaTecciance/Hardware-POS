/**
 * The retail domain — clothing first, grocery behind it (D99).
 *
 * D57 removed `RETAIL` on the finding that there was no Retail template and the
 * value carried zero rows. D99 supersedes that on its facts: a clothing retailer
 * is now in scope. The reasoning was never wrong — re-adding is cheap precisely
 * because the removal was clean.
 *
 * ## How this differs from HARDWARE, and why it is a separate descriptor
 *
 * The two share a rail, a module list and a capability set. They differ in the
 * one thing a shop owner cares about on day one:
 *
 * | | HARDWARE | RETAIL |
 * |---|---|---|
 * | inventory | `QUICKBOOKS` — a cache of an upstream ledger | **`LOCAL`** — the tenant owns its numbers |
 * | accounting | `QUICKBOOKS` | **`NONE`** |
 * | QUICKBOOKS module | present | **absent** |
 *
 * That is not a variation of one template; it is the opposite posture. A single
 * descriptor serving both would have to branch on business type somewhere, which
 * is exactly what D56 exists to prevent.
 *
 * ## What is deliberately reused
 *
 * `RETAIL_CAPABILITIES`, `RETAIL_NAVIGATION` and `HARDWARE_ROLE_TEMPLATES` are
 * adopted as-is, per D99's "reuse; do not fork". Three things worth knowing:
 *
 *  1. `RETAIL_CAPABILITIES` already declares `catalogue.variants: true`. **That
 *     is why the whole Phase 1 variant engine works here with no further code** —
 *     the picker, scan resolver, per-variant stock, cart key and stock ledger all
 *     read that capability and never a business type (D56).
 *  2. `RETAIL_NAVIGATION` contains a `/quickbooks` entry, and keeping it is
 *     correct: it is gated on `module: 'QUICKBOOKS'`, which this descriptor does
 *     not enable, so the rail entry never renders. Forking the navigation to
 *     delete a line the module gate already hides would create a second copy to
 *     keep in step for no gain (D93).
 *  3. `HARDWARE_ROLE_TEMPLATES` is Owner + Cashier, which is exactly how a
 *     clothing shop is staffed. A shared constant named for the other domain is
 *     a naming wart, not a coupling — renaming it would touch the hardware
 *     descriptor, and D56's contract is *zero edits to existing domains*.
 */
import { HARDWARE_ROLE_TEMPLATES } from '../types/role-templates.js';
import { RETAIL_CAPABILITIES } from './capabilities.js';
import type { DomainDescriptor } from './domain.types.js';
import { RETAIL_MODULES, SHARED_CORE_MODULES } from './modules.js';
import { RETAIL_NAVIGATION } from './navigation.js';

export const RETAIL_DOMAIN: DomainDescriptor = {
  businessTypes: ['RETAIL'],
  label: 'Retail shop',
  template: {
    key: 'RETAIL',
    name: 'Retail',
    description:
      'Clothing, grocery and general retail. Sell by size, colour or pack with ' +
      'per-variant stock and barcodes. Local inventory — no accounting integration.',
    // Hardware 1, Restaurant 2, Hotel 3 — so Retail takes 4. Appending rather
    // than slotting in beside Hardware, where it arguably belongs: any other
    // value collides, and resolving the collision means editing three
    // descriptors that have nothing to do with this change. D56's contract is
    // "zero edits to existing domains", and picker order is not worth breaking
    // it for. A tie would sort by registry insertion order, which is exactly the
    // kind of incidental ordering that looks deliberate until it moves.
    order: 4,
  },
  // D99 — the defining difference. `LOCAL` means the tenant owns its own stock
  // numbers, which is what makes per-variant `BranchInventory` rows authoritative
  // (D100) rather than a mirror of somebody else's ledger.
  profile: { inventoryMode: 'LOCAL', accountingProvider: 'NONE' },
  // RETAIL_MODULES minus QUICKBOOKS, per D99. Filtered rather than re-listed so a
  // module added to the shared list arrives here too; the exclusion is the only
  // thing this descriptor is asserting.
  modules: [...SHARED_CORE_MODULES, ...RETAIL_MODULES.filter((m) => m !== 'QUICKBOOKS')],
  navigation: RETAIL_NAVIGATION,
  roleTemplates: HARDWARE_ROLE_TEMPLATES,
  capabilities: RETAIL_CAPABILITIES,
  // Empty, declared rather than defaulted (D64). Size and colour are NOT
  // attributes — they are variation dimensions with their own price, barcode and
  // stock row, which is behaviour and therefore lives in columns. The descriptive
  // remainder (material, fit, care; brand, origin, allergens) is what will fill
  // this in 2.4 and 2.5. Until then every `attributes` key is refused, which is
  // the intended state: nothing is silently accepted.
  catalogue: { attributeSchema: [] },
};
