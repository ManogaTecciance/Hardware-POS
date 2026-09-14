/**
 * D161 — the tenant's own business details (`/products/business-details`).
 *
 * Distinct from `attributes-api.ts` beside it, and deliberately so:
 *
 *  - `GET /products/attribute-schema` answers "what does the Add Product wizard
 *    render?" — the RESOLVED list, whatever its origin. Every tenant has one.
 *  - this answers "what has this tenant CONFIGURED?" — the same list plus where
 *    it came from, and it refuses outright for a business type that does not
 *    offer the feature.
 *
 * The wizard keeps reading the first. Only the Settings tab reads this one, so
 * a tenant that never opens the tab issues no extra request.
 */

import type { AttributeField } from '@hardware-pos/shared';

import { api } from '../api';
import type { Session } from '../auth';

/**
 * `DOMAIN` — nothing configured yet, so the business type's own list is being
 * served. The tab says so, because "these five fields appeared by themselves"
 * is otherwise indistinguishable from "somebody typed these five fields".
 */
export type BusinessDetailsSource = 'TENANT' | 'DOMAIN';

export interface BusinessDetailsConfig {
  fields: AttributeField[];
  source: BusinessDetailsSource;
}

export async function fetchBusinessDetailsConfig(
  session: Session,
): Promise<BusinessDetailsConfig> {
  return api.get<BusinessDetailsConfig>('/products/business-details', {
    token: session.token,
    tenantId: session.user.tenantId,
  });
}

/**
 * Replace the whole list.
 *
 * PUT, not PATCH: the payload IS the definition (the server has replace
 * semantics for the same reason the attributes document does). An empty array
 * is a real answer — "we track no business details" — and the wizard responds
 * by dropping the step, so it must survive the round trip as `[]` and never be
 * coerced into "unset".
 */
export async function replaceBusinessDetails(
  session: Session,
  fields: AttributeField[],
): Promise<{ fields: AttributeField[] }> {
  return api.put<{ fields: AttributeField[] }>(
    '/products/business-details',
    { fields },
    { token: session.token, tenantId: session.user.tenantId },
  );
}
