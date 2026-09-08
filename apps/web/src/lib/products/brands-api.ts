/**
 * Brands — D133 (`8.9`).
 *
 * Per-tenant catalogue data, not a domain enum: the list is fetched, never
 * hard-coded. There is no delete — archiving is the operation, because removing
 * a brand would unlink every product that carries it.
 */

import { api } from '../api';
import type { Session } from '../auth';

function auth(session: Session): { token: string; tenantId: string } {
  return { token: session.token, tenantId: session.user.tenantId };
}

export interface Brand {
  id: string;
  name: string;
  isActive: boolean;
  /** How many products carry it. What makes archiving a considered act. */
  productCount: number;
}

export function fetchBrands(session: Session, includeArchived = false): Promise<Brand[]> {
  const q = includeArchived ? '?includeArchived=true' : '';
  return api.get<Brand[]>(`/brands${q}`, auth(session));
}

export function createBrand(session: Session, name: string): Promise<Brand> {
  return api.post<Brand>('/brands', { name }, auth(session));
}

export function updateBrand(
  session: Session,
  id: string,
  patch: { name?: string; isActive?: boolean },
): Promise<Brand> {
  return api.patch<Brand>(`/brands/${id}`, patch, auth(session));
}
