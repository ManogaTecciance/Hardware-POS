/**
 * D65 — a product's recipe / component list (convergence plan §8.8).
 *
 * Replace-all PUT, wizard-owned, mirroring the modifier-group junction
 * client. The server refuses writes for tenants whose domain does not
 * declare `capabilities.catalogue.components`; the wizard never calls `put`
 * for them (the recipe card does not render), so a 403 here means the two
 * fell out of step — surface it, don't swallow it.
 */

import { api } from '../api';
import type { Session } from '../auth';

export interface ProductComponentView {
  id: string;
  componentProductId: string;
  componentName: string;
  componentSku: string | null;
  /** Decimal strings, matching the server's ledger precision. */
  quantity: string;
  unit: string | null;
  wastageRate: string;
}

export interface ProductComponentInput {
  componentProductId: string;
  quantity: number;
  unit?: string;
  wastageRate?: number;
}

export async function fetchProductComponents(
  session: Session,
  productId: string,
): Promise<{ components: ProductComponentView[] }> {
  return api.get<{ components: ProductComponentView[] }>(`/products/${productId}/components`, {
    token: session.token,
    tenantId: session.user.tenantId,
  });
}

export async function putProductComponents(
  session: Session,
  productId: string,
  components: ProductComponentInput[],
): Promise<{ components: ProductComponentView[] }> {
  return api.put<{ components: ProductComponentView[] }>(
    `/products/${productId}/components`,
    { components },
    { token: session.token, tenantId: session.user.tenantId },
  );
}
