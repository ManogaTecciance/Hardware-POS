/**
 * D64 — the tenant domain's catalogue attribute schema (Phase 7).
 *
 * One declarative list drives the wizard's generic attributes step AND the
 * server-side validator, so the form and the refusal cannot drift. An empty
 * `fields` array is a real answer — "this vertical stores no domain
 * attributes" — and the wizard responds by not rendering the step at all.
 */

import type { AttributeField } from '@hardware-pos/shared';

import { api } from '../api';
import type { Session } from '../auth';

export type { AttributeField };

export async function fetchProductAttributeSchema(
  session: Session,
): Promise<{ fields: AttributeField[] }> {
  return api.get<{ fields: AttributeField[] }>('/products/attribute-schema', {
    token: session.token,
    tenantId: session.user.tenantId,
  });
}
