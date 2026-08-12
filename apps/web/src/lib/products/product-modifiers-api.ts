/**
 * Product ↔ ModifierGroup links (D45 — Restaurant wizard Step 3).
 *
 * The backend exposes two endpoints on the product itself so the wizard can
 * hydrate + persist links without knowing anything about a Menu Item wrapper
 * (a restaurant tenant may attach modifier groups to raw products without ever
 * creating a MenuItem — the same modifier group flows into both the Menu wizard
 * and the Product wizard).
 *
 * Follows the fetch/session-token conventions in `variants-api.ts` — every hop
 * uses the shared `api` helper so a 401 refresh + retry is applied uniformly.
 */

import { api } from '../api';
import type { Session } from '../auth';

export interface ProductModifierOption {
  id: string;
  name: string;
  priceDelta: number;
  position: number;
  isActive: boolean;
}

export interface ProductModifierGroup {
  id: string;
  name: string;
  selection: 'SINGLE' | 'MULTIPLE';
  minSelections: number;
  maxSelections: number;
  /** Wizard marker — 'SIZE' when the group backs a Size variation, `null` otherwise. */
  role: string | null;
  position: number;
  options: ProductModifierOption[];
}

// ── Raw wire shapes (decimals arrive as strings from Prisma) ─────────────────

interface ApiModifierOption {
  id: string;
  name: string;
  priceDelta: string | number;
  position: number;
  isActive: boolean;
}

interface ApiModifierGroup {
  id: string;
  name: string;
  selection: 'SINGLE' | 'MULTIPLE';
  minSelections: number;
  maxSelections: number;
  role: string | null;
  position: number;
  options: ApiModifierOption[];
}

function auth(session: Session): { token: string; tenantId: string } {
  return { token: session.token, tenantId: session.user.tenantId };
}

function toGroup(g: ApiModifierGroup): ProductModifierGroup {
  return {
    id: g.id,
    name: g.name,
    selection: g.selection,
    minSelections: g.minSelections,
    maxSelections: g.maxSelections,
    role: g.role,
    position: g.position,
    options: g.options.map((o) => ({
      id: o.id,
      name: o.name,
      priceDelta: Number(o.priceDelta),
      position: o.position,
      isActive: o.isActive,
    })),
  };
}

export async function fetchProductModifierGroups(
  session: Session,
  productId: string,
): Promise<{ modifierGroups: ProductModifierGroup[] }> {
  const res = await api.get<{ modifierGroups: ApiModifierGroup[] }>(
    `/products/${productId}/modifier-groups`,
    auth(session),
  );
  return { modifierGroups: res.modifierGroups.map(toGroup) };
}

/**
 * Replace the product's attached modifier groups with the given set.
 *
 * The server treats this as a full replacement (PUT semantics): omitted ids are
 * detached, new ids are attached. The wizard never sends a partial diff.
 */
export async function putProductModifierGroups(
  session: Session,
  productId: string,
  modifierGroupIds: string[],
): Promise<{ modifierGroups: ProductModifierGroup[] }> {
  const res = await api.put<{ modifierGroups: ApiModifierGroup[] }>(
    `/products/${productId}/modifier-groups`,
    { modifierGroupIds },
    auth(session),
  );
  return { modifierGroups: res.modifierGroups.map(toGroup) };
}
