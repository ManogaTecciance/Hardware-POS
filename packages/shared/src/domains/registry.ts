/**
 * The domain registry — the ONE place a vertical is wired in (D56).
 *
 * Total over `BusinessType` with **no fallback, by design**. The map this
 * replaced (`NAV_BY_BUSINESS_TYPE[t] ?? RETAIL_NAV`) is precisely the
 * mechanism that silently handed HOTEL the wrong screens: an unknown domain
 * fell back to retail instead of failing the build. Here, a `BusinessType`
 * value without a registry entry is a compile error, and `domainFor` cannot
 * return undefined.
 */
import type { RoleTemplate } from '../types/role-templates.js';
import { BUSINESS_TYPE_VALUES, type BusinessType } from '../types/platform.js';
import type { DomainDescriptor } from './domain.types.js';
import { FOOD_SERVICE_DOMAIN } from './food-service.domain.js';
import { GENERAL_DOMAIN } from './general.domain.js';
import { HARDWARE_DOMAIN } from './hardware.domain.js';
import { HOTEL_DOMAIN } from './hotel.domain.js';
import { RETAIL_DOMAIN } from './retail.domain.js';

export const DOMAIN_REGISTRY: Record<BusinessType, DomainDescriptor> = {
  HARDWARE: HARDWARE_DOMAIN,
  RESTAURANT: FOOD_SERVICE_DOMAIN,
  CAFE: FOOD_SERVICE_DOMAIN,
  BAKERY: FOOD_SERVICE_DOMAIN,
  HOTEL: HOTEL_DOMAIN,
  GENERAL: GENERAL_DOMAIN,
  // D99. The registry is total, so adding `RETAIL` to `BusinessType` without
  // this line is a COMPILE ERROR — which is why 2.1 and 2.2 land together.
  RETAIL: RETAIL_DOMAIN,
};

export function domainFor(businessType: BusinessType): DomainDescriptor {
  return DOMAIN_REGISTRY[businessType];
}

/**
 * Templates a tenant of this business type is provisioned with.
 *
 * Takes `string` because seeding and provisioning read the value from
 * CLI arguments and database rows — and THROWS on an unknown one rather than
 * falling back. The if-chain this replaced silently handed an unknown type
 * the built-in roles only, which is exactly the wrong-by-default behaviour
 * the registry exists to end.
 */
export function roleTemplatesForBusinessType(businessType: string): readonly RoleTemplate[] {
  const entry = (DOMAIN_REGISTRY as Record<string, DomainDescriptor | undefined>)[businessType];
  if (!entry) {
    throw new Error(
      `Unknown business type "${businessType}". Valid values: ${BUSINESS_TYPE_VALUES.join(', ')}.`,
    );
  }
  return entry.roleTemplates;
}

/**
 * The templates the platform console offers (D55), derived from the registry
 * rather than hand-written — a new domain appears in the picker by existing,
 * unless it is deliberately withheld here.
 */
const OFFERED_TEMPLATE_KEYS: readonly string[] = ['HARDWARE', 'RESTAURANT', 'HOTEL', 'RETAIL'];

export interface WorkspaceTemplateView {
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly businessType: BusinessType;
}

export const WORKSPACE_TEMPLATES: readonly WorkspaceTemplateView[] = [
  ...new Set(Object.values(DOMAIN_REGISTRY)),
]
  .filter((d) => OFFERED_TEMPLATE_KEYS.includes(d.template.key))
  .sort((a, b) => a.template.order - b.template.order)
  .map((d) => ({
    key: d.template.key,
    name: d.template.name,
    description: d.template.description,
    // The template creates a tenant of the descriptor's FIRST business type —
    // the canonical one; the others exist for data distinguishability.
    businessType: d.businessTypes[0] as BusinessType,
  }));
