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
import type { TenantCapabilities } from './capabilities.js';
import type { NavGroupSpec } from './navigation.js';

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
}
