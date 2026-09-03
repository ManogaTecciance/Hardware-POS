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
  /*
   * D103 — `PROMOTIONS` is declared HERE rather than added to `RETAIL_MODULES`.
   *
   * `HARDWARE` composes its default set from `RETAIL_MODULES` too, and
   * `platform.constants.spec` pins that set as byte-equal to
   * `LEGACY_TENANT_DEFAULTS` — the modules a tenant with no business profile
   * falls back to. Adding it there would quietly widen another team's template
   * and the legacy fallback with it. This template declares the module it needs.
   *
   * Hardware never had a working Promotions screen either (the D45 hotfix gated
   * it on MENU_MANAGEMENT, which hardware also lacks). That is theirs to decide,
   * and a `TenantModule` row enables it per tenant meanwhile.
   */
  modules: [
    ...SHARED_CORE_MODULES,
    ...RETAIL_MODULES.filter((m) => m !== 'QUICKBOOKS'),
    'PROMOTIONS',
  ],
  navigation: RETAIL_NAVIGATION,
  roleTemplates: HARDWARE_ROLE_TEMPLATES,
  capabilities: RETAIL_CAPABILITIES,
  /**
   * D64 (2.4) — the clothing catalogue fields.
   *
   * ## Why these are attributes and size/colour are not
   *
   * The test: **if changing the value changes what the cashier scans, it is a
   * variation dimension; if it changes only what the label says, it is an
   * attribute.** A Medium has its own price, barcode and stock row — you sell
   * *a Medium*. "Slim fit" changes nothing the engine touches: not what is
   * scanned, not what is priced, not what is depleted. It is printed and
   * reported on, and nothing more.
   *
   * So size and colour live in `ProductVariationDimension` (Phase 1), and these
   * five live in `Product.attributes` — validated, but never computed on.
   *
   * ## Why every field is optional
   *
   * `required: true` blocks product creation for a tenant that does not track
   * the field. A shop that never records fabric composition should not be unable
   * to add a product; a shop that does gets a validated place to put it.
   *
   * ## Why `brand` is absent
   *
   * It is a **column eventually** (Phase 8 step 8.8 — "brand as an entity"):
   * filtered and reported on, and free text will not survive real data.
   * Declaring it here now would mean migrating tenants' stored strings into an
   * entity later. Leaving it out costs nothing today.
   *
   * ## Why grocery is absent
   *
   * `schemaForTenant` resolves ONE schema per business type, and clothing and
   * grocery are both `RETAIL`. A merged list would show a clothing shop an
   * "Allergens" field. 2.5 is blocked on a decision to split the enum, which is
   * out of scope while clothing is the pilot.
   *
   * ## Adding is safe; removing is not
   *
   * `validateAttributes` refuses unknown keys, so deleting a field later strands
   * whatever tenants have stored under it on their next full write. This list is
   * a commitment, not a sketch.
   */
  catalogue: {
    attributeSchema: [
      // "60% cotton, 40% polyester" — free text because the combinations are
      // endless and nothing groups on the exact string.
      { key: 'material', label: 'Material', type: 'text', maxLength: 120 },
      // A fixed list precisely because this IS grouped on in reports; free text
      // would give "slim", "Slim", "slim-fit" as three different cuts.
      { key: 'fit', label: 'Fit', type: 'enum', options: ['Regular', 'Slim', 'Relaxed', 'Oversized'] },
      // Wash symbols in words, for the tag and the product page.
      { key: 'careInstructions', label: 'Care instructions', type: 'text', maxLength: 240 },
      // The most common reporting axis in clothing retail after size.
      {
        key: 'gender',
        label: 'Gender',
        type: 'enum',
        options: ['Men', 'Women', 'Unisex', 'Boys', 'Girls'],
      },
      { key: 'season', label: 'Season', type: 'enum', options: ['All season', 'Summer', 'Winter'] },
    ],
  },
};
