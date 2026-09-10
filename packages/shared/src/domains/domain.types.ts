/**
 * Domain packs (convergence plan §4, D56).
 *
 * A DomainDescriptor is everything that varies by workspace template, declared
 * in one file per vertical. Before this existed, adding a vertical touched
 * fifteen places — seven scattered maps plus inline predicates — and eleven of
 * them failed SILENTLY: `NAV_BY_BUSINESS_TYPE[t] ?? RETAIL_NAV` handed an
 * unknown domain the retail rail, `resolveBusinessKind` fell back to retail
 * chrome, and six page bodies did their own `=== 'RESTAURANT' || …`
 * comparisons. HOTEL shipped missing seven of the fifteen, which is how a
 * hotel workspace got the restaurant sidebar and the retail POS behind it.
 *
 * The extension contract this type exists to keep:
 *
 * > A vertical that composes existing behaviours = one descriptor file, one
 * > registry line, one BusinessType value. Zero edits to existing domains.
 *
 * Fields for later phases (fulfilment provider spec, catalogue attribute
 * schema, seed data) are added HERE when their phase lands — additively, so
 * existing descriptors keep compiling until they choose to answer.
 */
import type { RoleTemplate } from '../types/role-templates.js';
import type {
  AccountingProviderKind,
  BusinessType,
  InventoryMode,
  ModuleKey,
} from '../types/platform.js';
import type { AttributeField } from './attributes.js';
import type { TenantCapabilities } from './capabilities.js';
import type { NavGroupSpec } from './navigation.js';

/**
 * D142 — one line of a sample document.
 *
 * Deliberately the shape the A4 renderer's line builder already consumed, so
 * moving the existing hardware list here was a relocation rather than a
 * rewrite — which is what let hardware's rendered preview stay byte-identical
 * through the change.
 */
export interface SampleCatalogueItem {
  readonly name: string;
  readonly sku: string;
  /** Unit label as printed — BAG, PCS, M, PAIR. */
  readonly unit: string;
  readonly unitPrice: number;
  /** Quantity multiplier, for goods bought by the box rather than singly. */
  readonly pack?: number;
}

export interface DomainDescriptor {
  /** The BusinessType values this descriptor serves. */
  readonly businessTypes: readonly BusinessType[];

  /** Human label, used everywhere a business type is displayed. */
  readonly label: string;

  /**
   * Workspace-template presentation for the platform console (D55).
   * `order` places it in the picker; a descriptor without one is not offered
   * as a template (none exists today — every domain is creatable).
   */
  readonly template: {
    readonly key: string;
    readonly name: string;
    readonly description: string;
    readonly order: number;
  };

  /** The inventory/accounting pair a new tenant of this domain gets. */
  readonly profile: {
    readonly inventoryMode: InventoryMode;
    readonly accountingProvider: AccountingProviderKind;
  };

  /** Modules enabled by default for a new tenant. */
  readonly modules: readonly ModuleKey[];

  /** Navigation, declared as data — see `navigation.ts` for why icon names. */
  readonly navigation: readonly NavGroupSpec[];

  /** Roles seeded into a new tenant of this domain. */
  readonly roleTemplates: readonly RoleTemplate[];

  /** What this domain's tenants can do. See `capabilities.ts`. */
  readonly capabilities: TenantCapabilities;

  /**
   * Catalogue authoring, declared as data (Phase 7, D64). Required — not
   * optional — so a new descriptor must SAY "no attributes" rather than get
   * it by omission; the silent-fallback failure mode is the one this whole
   * module exists to end.
   */
  readonly catalogue: {
    /**
     * Declarative field list for `Product.attributes` — drives the generic
     * wizard step AND the server-side validator (see `attributes.ts`).
     * Empty = this vertical stores no domain attributes, and every key is
     * refused.
     */
    readonly attributeSchema: readonly AttributeField[];
    /**
     * D142 — the goods this vertical's DOCUMENT PREVIEWS are illustrated with.
     *
     * Settings → Preview renders a sample quotation so an operator can check
     * their letterhead, column widths and spacing before printing anything
     * real. Until D142 that sample was one hard-coded hardware list, so a
     * clothing shop evaluating the product saw a quotation for Portland
     * cement and TMT steel bar on its own letterhead.
     *
     * ## Why this one is OPTIONAL when the block above says required
     *
     * The comment on `catalogue` is right, and this is the exception that
     * proves its reasoning rather than an erosion of it. That rule exists
     * because a silent fallback hands a vertical **another vertical's**
     * answer — which is exactly the defect D142 fixes.
     *
     * Omitting this field falls back to a NEUTRAL list (`Standard Item 1`
     * and so on), not to hardware's. Silence therefore produces honest
     * filler that claims no trade, and the failure mode the required rule
     * guards against cannot occur. Making it required would instead force
     * an edit to the food-service and general descriptors — templates
     * another team owns — to declare something about a screen food
     * service never even renders.
     *
     * Illustration only. Nothing here is sold, priced, stocked or
     * provisioned; a workspace's real catalogue comes from its seed pack.
     */
    readonly sampleItems?: readonly SampleCatalogueItem[];
  };
}
