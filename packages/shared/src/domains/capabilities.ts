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
 * `collections` and `components` are declared false everywhere until the
 * phases that build them flip them on. A capability that is true with nothing
 * behind it would teach consumers to distrust the object.
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
    /** A pre-payment bill is issued separately from the receipt. */
    readonly proformaBill: boolean;
    readonly splitByItem: boolean;
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
    collections: false,
    components: false,
  },
  fulfilment: { kind: 'IMMEDIATE', stationRouting: false, rounds: false, channels: ['COUNTER'] },
  charges: { serviceCharge: false, packaging: false },
  documents: { proformaBill: false, splitByItem: false },
};

/** Food service: table sessions, rounds, kitchen routing, split bills. */
export const FOOD_SERVICE_CAPABILITIES: TenantCapabilities = {
  catalogue: {
    variants: true,
    modifiers: true,
    preparation: true,
    collections: false,
    components: false,
  },
  fulfilment: {
    kind: 'TABLE_SERVICE',
    stationRouting: true,
    rounds: true,
    channels: ['DINE_IN', 'TAKEAWAY', 'ONLINE'],
  },
  charges: { serviceCharge: true, packaging: true },
  documents: { proformaBill: true, splitByItem: true },
};

/** A catalogue without stock tracking; sells over the counter. */
export const GENERAL_CAPABILITIES: TenantCapabilities = {
  catalogue: {
    variants: true,
    modifiers: false,
    preparation: false,
    collections: false,
    components: false,
  },
  fulfilment: { kind: 'IMMEDIATE', stationRouting: false, rounds: false, channels: ['COUNTER'] },
  charges: { serviceCharge: false, packaging: false },
  documents: { proformaBill: false, splitByItem: false },
};
