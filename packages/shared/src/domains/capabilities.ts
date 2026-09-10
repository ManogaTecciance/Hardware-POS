/**
 * Tenant capabilities (convergence plan §5, D56).
 *
 * A capability answers "can this tenant's users do X?" — resolved ONCE, from
 * the tenant's domain descriptor, and passed down. No component, page or
 * service compares `businessType`; they read a capability. This is D31's rule
 * ("variation is resolved by a resolver, and the result is a value object")
 * generalised from the product screens to the whole platform, because the
 * inline predicates it replaced omitted HOTEL in seven separate places.
 *
 * ## Capabilities are affordances, never permission
 *
 * A hidden control is usability; the server still refuses the request. A
 * tenant whose `fulfilment.kind` is IMMEDIATE is refused by `ModuleAccessGuard`
 * on every table-service route regardless of what any client renders.
 *
 * ## A capability describes what works TODAY
 *
 * `collections` and `components` were declared false everywhere until the
 * phases that built them flipped them on (components: Phase 8/D65 for food
 * service). A capability that is true with nothing behind it would teach
 * consumers to distrust the object.
 */

/**
 * Sales channels. `COUNTER` is the immediate-fulfilment (retail) channel; the
 * three food-service values keep the names of the existing
 * `RestaurantOrderChannel` enum so no data changes meaning when the
 * settlement document gains a channel column (plan §8.2, Phase 1).
 */
export const ORDER_CHANNEL_VALUES = ['COUNTER', 'DINE_IN', 'TAKEAWAY', 'ONLINE'] as const;
export type OrderChannel = (typeof ORDER_CHANNEL_VALUES)[number];

/**
 * How a sale comes into being. Phase 4 gives each kind a FulfilmentProvider;
 * until then the kind is what the client shells branch on instead of
 * business types.
 */
export const FULFILMENT_KIND_VALUES = ['IMMEDIATE', 'TABLE_SERVICE'] as const;
export type FulfilmentKind = (typeof FULFILMENT_KIND_VALUES)[number];

export interface TenantCapabilities {
  readonly catalogue: {
    /** Product variants are offered in the wizard and the POS picker. */
    readonly variants: boolean;
    /** Modifier groups are authored on products and offered at the till. */
    readonly modifiers: boolean;
    /** prepMinutes / dietaryTags / foodType are authored and displayed. */
    readonly preparation: boolean;
    /** The catalogue is curated into collections (Phase 9). */
    readonly collections: boolean;
    /** Composed items carry component lists / recipes (Phase 8). */
    readonly components: boolean;
    /**
     * D134 / D134e — products may be sold by WEIGHT OR MEASURE: the wizard
     * offers “How is this sold?” and the till opens a quantity keypad.
     *
     * **Optional, and absent means `false`.** Every other capability here is
     * required, because the registry is total and a new vertical forgetting
     * one should be a compile error. This one is deliberately the exception:
     * absent means “this domain does not sell by measure”, which is the
     * SAFE reading, and it is what every domain but retail wants. Making it
     * required would mean writing `measuredGoods: false` into the hardware
     * and food-service capability blocks — editing two templates in order to
     * declare that nothing about them changes.
     *
     * `RETAIL_CAPABILITIES` is shared by the HARDWARE and RETAIL domains
     * (read its own docstring: “the hardware/retail template”), so the flag
     * cannot live in it — it is set on the retail DESCRIPTOR instead, which
     * is the only place the two differ.
     *
     * Hardware is not excluded because selling rope by the metre is absurd —
     * it is excluded because the PO has not asked for it. A capability must
     * not claim more than the product offers.
     */
    readonly measuredGoods?: boolean;
    /**
     * D64 / D150 — the tenant defines its own **business details**: the extra
     * per-product fields Step 2 of the wizard collects into
     * `Product.attributes`.
     *
     * Without this the domain's declared `catalogue.attributeSchema` is the
     * whole answer, exactly as it has been — a hotel keeps its three fields,
     * hardware and food service keep none, and no Settings tab appears.
     *
     * Optional for the same reason as `measuredGoods` above: absent means
     * false, which is what every domain but retail wants, and requiring it
     * would mean editing the hardware and food-service blocks to declare that
     * nothing about them changes.
     */
    readonly configurableBusinessDetails?: boolean;
    /**
     * D151 — the reusable **attribute library** (`Products → Attributes`).
     *
     * Naming "Size" and its options once, then reusing them across products,
     * pays for itself in a catalogue with many variants of the same few scales.
     * A hardware counter types a variation when it needs one and does not keep
     * a library of them, and a kitchen's variants are not scales at all — for
     * both the screen is a door to a feature they never walk through.
     *
     * **The API stays shared core.** D125 gated `/attribute-library` on
     * permission, not on business type, deliberately: any workspace that DOES
     * want a library may use one. This hides a tab, which is usability
     * (CLAUDE.md), and changes no authority.
     *
     * Optional, absent means `false`, for the same reason as the two above.
     */
    readonly attributeLibrary?: boolean;
    /**
     * D151 — **internal barcodes** (`Products → Barcodes`).
     *
     * Allocating EAN-13s from an in-store range, auditing them and printing
     * shelf labels is a stocked-goods activity (Phase 5, D125/D106). A kitchen
     * does not barcode a portion of rice, so the screen is noise on a
     * food-service workspace.
     *
     * Declared on `RETAIL_CAPABILITIES`, which is the HARDWARE template as well
     * as retail's base — both stock and label physical goods, and both keep it.
     */
    readonly internalBarcodes?: boolean;
  };
  readonly fulfilment: {
    readonly kind: FulfilmentKind;
    /** Items route to preparation stations at submit time. */
    readonly stationRouting: boolean;
    /** Orders accumulate in rounds rather than settling at once. */
    readonly rounds: boolean;
    /** Channels this tenant may sell through. */
    readonly channels: readonly OrderChannel[];
  };
  readonly charges: {
    readonly serviceCharge: boolean;
    readonly packaging: boolean;
  };
  readonly documents: {
    /**
     * A pre-payment bill is issued separately from the receipt.
     *
     * A food-service fact: the bill you bring to a table before anyone has
     * paid. **Not** a statement about paper. It was the Settings screen's
     * A4-vs-thermal discriminator until D152, which is why retail could not
     * be moved to a thermal bill without asserting something false about it:
     * a shop rings up and prints a receipt, it issues no proforma.
     */
    readonly proformaBill: boolean;
    readonly splitByItem: boolean;
    /**
     * D152 — the customer's BILL prints on an 80mm roll, not an A4 sheet.
     *
     * This is the paper question, asked directly. A kitchen and a clothing
     * shop both hand over a slip from a till-top printer; they have almost
     * nothing else in common, which is exactly why the old proxy could not
     * serve both.
     */
    readonly thermalBill?: boolean;
    /**
     * D152 — the tenant issues A4 documents on a letterhead.
     *
     * Quotations and printed notes: the documents whose logo, accent colour,
     * signature block, stamp, page size and column set live on the Branding
     * and Layout tabs.
     *
     * **Independent of `thermalBill`, and retail is why.** A retail workspace
     * prints its bill on a roll AND quotes on a letterhead, so the two are
     * separate facts rather than two ends of one switch. Collapsing them
     * would leave a retail owner with a quotation they cannot brand.
     */
    readonly a4Documents?: boolean;
  };
}

/**
 * The hardware/retail template: immediate counter sales, variants, no
 * kitchen concepts. `modifiers: false` is open decision Q3 — the schema
 * supports retail modifiers today, but enabling them is a product decision
 * the PO has not made, and a capability must not claim more than the product
 * offers.
 */
export const RETAIL_CAPABILITIES: TenantCapabilities = {
  catalogue: {
    variants: true,
    modifiers: false,
    preparation: false,
    // D66 (Phase 9): retail curates collections too ("Trade counter",
    // "Seasonal") — the plan's original motivation for renaming menus.
    collections: true,
    components: false,
    // D151 — hardware and retail both stock and label physical goods, so both
    // keep the Barcodes screen. `attributeLibrary` is deliberately NOT here:
    // this constant IS the hardware template, and only retail wants that tab,
    // so it is declared on the retail descriptor instead (the D134e pattern).
    internalBarcodes: true,
  },
  fulfilment: { kind: 'IMMEDIATE', stationRouting: false, rounds: false, channels: ['COUNTER'] },
  charges: { serviceCharge: false, packaging: false },
  // D152 — hardware and retail both quote on a letterhead, so the A4 document
  // set is here. `thermalBill` is NOT: this constant is the hardware template,
  // hardware still prints its bill on A4, and only retail moved to a roll.
  documents: { proformaBill: false, splitByItem: false, a4Documents: true },
};

/** Food service: table sessions, rounds, kitchen routing, split bills. */
export const FOOD_SERVICE_CAPABILITIES: TenantCapabilities = {
  catalogue: {
    variants: true,
    modifiers: true,
    preparation: true,
    // D66 (Phase 9): menus ARE collections — the capability now says so.
    collections: true,
    // D65 (Phase 8): recipes are authorable and rounds deplete through them.
    components: true,
  },
  fulfilment: {
    kind: 'TABLE_SERVICE',
    stationRouting: true,
    rounds: true,
    channels: ['DINE_IN', 'TAKEAWAY', 'ONLINE'],
  },
  charges: { serviceCharge: true, packaging: true },
  // D152 — `thermalBill` states directly what `proformaBill` was standing in
  // for. Additive and behaviour-preserving: food service resolved to the
  // thermal surface before this line and resolves to it after. `a4Documents`
  // stays absent — a kitchen issues no quotation, which is the whole reason
  // its Branding and Layout tabs lost the letterhead controls in D96.
  documents: { proformaBill: true, splitByItem: true, thermalBill: true },
};

/** A catalogue without stock tracking; sells over the counter. */
export const GENERAL_CAPABILITIES: TenantCapabilities = {
  catalogue: {
    variants: true,
    modifiers: false,
    preparation: false,
    collections: false,
    components: false,
    // D151 — unchanged: the general template showed both catalogue tabs before
    // this decision and nothing asked for that to change. Stated explicitly
    // rather than inherited, because absent means false and silence here would
    // remove two working screens from a template nobody was talking about.
    attributeLibrary: true,
    internalBarcodes: true,
  },
  fulfilment: { kind: 'IMMEDIATE', stationRouting: false, rounds: false, channels: ['COUNTER'] },
  charges: { serviceCharge: false, packaging: false },
  // D152 — unchanged: A4 documents, no thermal bill. Stated rather than
  // inherited, because absent means false and silence would quietly move a
  // template nobody was discussing onto a different surface.
  documents: { proformaBill: false, splitByItem: false, a4Documents: true },
};
