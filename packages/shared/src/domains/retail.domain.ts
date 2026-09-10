/**
 * The retail domain — clothing first, grocery behind it (D120).
 *
 * D57 removed `RETAIL` on the finding that there was no Retail template and the
 * value carried zero rows. D120 supersedes that on its facts: a clothing retailer
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
 * adopted as-is, per D120's "reuse; do not fork". Three things worth knowing:
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
import { GENERAL_ROLE_TEMPLATES } from '../types/role-templates.js';
import { RETAIL_CAPABILITIES } from './capabilities.js';
import type { DomainDescriptor, SampleCatalogueItem } from './domain.types.js';
import { RETAIL_MODULES, SHARED_CORE_MODULES } from './modules.js';
import { RETAIL_NAVIGATION } from './navigation.js';

/**
 * D154 — the goods a retail workspace's document previews show.
 *
 * Clothing AND groceries in one list, because RETAIL is a single business
 * type covering both (Q12 resolved not to split it) and a sample showing only
 * one would look wrong to half the workspaces that see it. The same reasoning,
 * and deliberately the same goods, as the thermal bill's sample (D153), so a
 * shop's two documents illustrate the same shop.
 *
 * One line carries a `pack`, so the preview still exercises the multiplied-
 * quantity path that hardware's wire-by-the-metre line was the only case of.
 */
const RETAIL_SAMPLE_ITEMS: readonly SampleCatalogueItem[] = [
  { name: 'Cotton Shirt — Blue, Medium', sku: 'SHRT-CTN-M', unit: 'PCS', unitPrice: 3450 },
  { name: 'Ladies Denim Jeans — 32', sku: 'JEAN-LD-32', unit: 'PCS', unitPrice: 6900 },
  { name: 'Kids T-Shirt — 5-6 yrs', sku: 'TSHT-KD-56', unit: 'PCS', unitPrice: 1650 },
  { name: 'Basmati Rice (per kg)', sku: 'RICE-BAS', unit: 'KG', unitPrice: 720 },
  { name: 'Coconut Oil 1L', sku: 'OIL-CN-1L', unit: 'BTL', unitPrice: 1180 },
  { name: 'Red Lentils (per kg)', sku: 'LENT-RED', unit: 'KG', unitPrice: 640 },
  { name: 'Bath Towel — Large', sku: 'TOWL-LG', unit: 'PCS', unitPrice: 2250 },
  { name: 'Milk Powder 400g', sku: 'MILK-400', unit: 'PKT', unitPrice: 1490, pack: 6 },
];

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
  // D120 — the defining difference. `LOCAL` means the tenant owns its own stock
  // numbers, which is what makes per-variant `BranchInventory` rows authoritative
  // (D121) rather than a mirror of somebody else's ledger.
  profile: { inventoryMode: 'LOCAL', accountingProvider: 'NONE' },
  // RETAIL_MODULES minus QUICKBOOKS, per D120. Filtered rather than re-listed so a
  // module added to the shared list arrives here too; the exclusion is the only
  // thing this descriptor is asserting.
  /*
   * D124 — `PROMOTIONS` is declared HERE rather than added to `RETAIL_MODULES`.
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
  /*
   * D120 wanted "Owner + Cashier, which is exactly how a clothing shop staffs":
   * at the time that was `HARDWARE_ROLE_TEMPLATES`. D108 has since given the
   * hardware template a third, hardware-ONLY built-in, the Salesperson, so
   * that list no longer means Owner + Cashier. `GENERAL_ROLE_TEMPLATES` is
   * exactly those two. Whether a clothing shop should offer a Salesperson too
   * is a product question recorded in the merge (D136), not decided here.
   */
  roleTemplates: GENERAL_ROLE_TEMPLATES,
  /**
   * D134e — `RETAIL_CAPABILITIES` verbatim, plus weighed goods.
   *
   * Spread rather than added to the shared constant, because that constant
   * is the HARDWARE template too. A grocer sells rice by the kilo; a
   * hardware shop has not asked to, and Phase 6 must not decide that for
   * them. This is the only line on which the two domains differ, and it is
   * stated here rather than by a business-type comparison in a component —
   * D56, and the reason `resolveBusinessKind` reads a capability instead of
   * an if-chain that had already forgotten HOTEL once.
   */
  capabilities: {
    ...RETAIL_CAPABILITIES,
    catalogue: {
      ...RETAIL_CAPABILITIES.catalogue,
      measuredGoods: true,
      // D150 — a clothing shop and a grocer track different things about a
      // product, and the five fields declared below are the CLOTHING answer.
      // Retail is the domain that has to serve both, so it is the domain that
      // gets to redefine them. Spread for the same reason `measuredGoods` is:
      // `RETAIL_CAPABILITIES` is the hardware template too.
      configurableBusinessDetails: true,
      // D151 — the attribute library is retail's, not hardware's. Both read
      // `RETAIL_CAPABILITIES`, so declaring it there would hand the tab to a
      // hardware counter that types a variation when it needs one and keeps no
      // library of them. Same reason `measuredGoods` sits here. `internalBarcodes`
      // is NOT repeated: it is on the shared constant precisely because hardware
      // keeps it too, and restating it here would invite the two to drift.
      attributeLibrary: true,
    },
    // D152 — retail's bill prints on a roll. Spread onto the descriptor, not
    // into `RETAIL_CAPABILITIES`, because that constant IS the hardware
    // template and hardware still prints an A4 bill. `a4Documents` stays true
    // through the spread: a shop quotes on a letterhead even though its bill
    // is a slip, and those are two facts rather than one switch.
    documents: { ...RETAIL_CAPABILITIES.documents, thermalBill: true },
  },
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
   * ## Why `brand` is absent — and it now IS an entity
   *
   * This list said brand was "a column eventually (Phase 8 — brand as an
   * entity): filtered and reported on, and free text will not survive real
   * data. Declaring it here now would mean migrating tenants' stored strings
   * into an entity later."
   *
   * **`8.9` built it (D133)**, and the prediction paid off exactly: because
   * `brand` was never an attribute, no tenant had a stored string to migrate.
   * It is `Brand` — a per-tenant row — with a nullable `Product.brandId`. It
   * stays out of this list permanently: an attribute is validated and printed,
   * and a brand is joined to and filtered on.
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
    // D154 — a clothing shop previewing a quotation sees clothing.
    sampleItems: RETAIL_SAMPLE_ITEMS,
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
