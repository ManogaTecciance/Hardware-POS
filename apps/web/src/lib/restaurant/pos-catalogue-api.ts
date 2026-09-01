/**
 * Client for `GET /restaurant/pos-catalogue` (D45 Phase 2).
 *
 * Returns the tenant's active POS-sellable Products for a branch, shaped for
 * the runtime picker: category / subcategory grouping, variants inline,
 * modifier groups + options inline, kitchen stations, active promotions.
 *
 * ## Numbers arrive as strings
 *
 * Prisma serialises `Decimal` as a JSON string, and the backend forwards
 * that verbatim. Every money / quantity field on the wire is normalised to
 * `number` here so callers work with plain numeric values whether they read
 * from a fresh POST-fetch or a cached list — the same convention as
 * `variants-api.ts`.
 *
 * ## Why this is separate from `menus`/`menuItems`
 *
 * The Restaurant Menu APIs (menus / sections / items / modifier groups)
 * stay in `apps/web/src/lib/restaurant/api.ts` because a) historical
 * MenuItems still need admin access via typed `/menu` URLs and b) the
 * MenuItem wizard writes into them. This client speaks a different shape
 * entirely — Products, not MenuItems — and only supports the runtime read
 * path. Do not conflate the two.
 */

import { api } from '../api';
import type { Session } from '../auth';

// ── Wire types ───────────────────────────────────────────────────────────────

export type PosCatalogueFoodType = 'FOOD' | 'BEVERAGE' | 'DESSERT';
export type PosCatalogueChannel = 'DINE_IN' | 'TAKEAWAY' | 'ONLINE';

export interface PosCatalogueVariant {
  id: string;
  sku: string;
  name: string;
  unitPrice: number;
  isDefault: boolean;
  isActive: boolean;
}

export interface PosCatalogueOption {
  id: string;
  name: string;
  priceDelta: number;
  isActive: boolean;
}

export interface PosCatalogueModifierGroup {
  id: string;
  name: string;
  selection: 'SINGLE' | 'MULTIPLE';
  minSelections: number;
  maxSelections: number;
  /** Wizard marker — 'SIZE' for variations, null for a plain modifier group. */
  role: string | null;
  options: PosCatalogueOption[];
}

export interface PosCatalogueStation {
  id: string;
  code: string;
  name: string;
  category: string;
}

export interface PosCataloguePromotion {
  id: string;
  name: string;
  type: string;
  description: string | null;
}

export interface PosCatalogueItem {
  id: string;
  name: string;
  description: string | null;
  imageUrl: string | null;
  unitPrice: number | null;
  prepMinutes: number | null;
  dietaryTags: string[];
  foodType: PosCatalogueFoodType | null;
  category: { id: string; name: string } | null;
  subcategory: { id: string; name: string } | null;
  hasVariants: boolean;
  variants: PosCatalogueVariant[];
  modifierGroups: PosCatalogueModifierGroup[];
  stations: PosCatalogueStation[];
  promotions: PosCataloguePromotion[];
}

export interface PosCatalogueResponse {
  items: PosCatalogueItem[];
  /** Rows matching the filter, across every page — not the page length. */
  total: number;
  /**
   * Keyset cursor for the next page, or `null` on the last one.
   *
   * Forwarded verbatim from the server. Before this existed the client
   * dropped it, which made the response indistinguishable from a complete
   * catalogue and silently capped the POS at the server's default page.
   */
  nextCursor: string | null;
}

export interface PosCatalogueQuery {
  branchId: string;
  channel?: PosCatalogueChannel;
  foodType?: PosCatalogueFoodType;
  /** Server-side match over name, dietary tags and subcategory name. */
  search?: string;
  /** Page size. The server clamps to 1..200 and defaults to 100. */
  limit?: number;
  /** `nextCursor` from the previous page. Omit for the first page. */
  cursor?: string;
}

// ── Raw shapes (decimals arrive as strings) ──────────────────────────────────

interface ApiVariant {
  id: string;
  sku: string;
  name: string;
  unitPrice: string | number;
  isDefault: boolean;
  isActive: boolean;
}

interface ApiOption {
  id: string;
  name: string;
  priceDelta: string | number;
  isActive: boolean;
}

interface ApiModifierGroup {
  id: string;
  name: string;
  selection: 'SINGLE' | 'MULTIPLE';
  minSelections: number;
  maxSelections: number;
  role: string | null;
  options: ApiOption[];
}

interface ApiItem {
  id: string;
  name: string;
  description: string | null;
  imageUrl: string | null;
  unitPrice: string | number | null;
  // D62 — /products/sellable is capability-shaped: these keys are ABSENT
  // (not empty) for tenants without the capability. A food-service session
  // always has them; the mapper still defaults so a mid-flight capability
  // change cannot crash the grid.
  prepMinutes?: number | null;
  dietaryTags?: string[];
  foodType?: PosCatalogueFoodType | null;
  category: { id: string; name: string } | null;
  subcategory: { id: string; name: string } | null;
  hasVariants: boolean;
  variants?: ApiVariant[];
  modifierGroups?: ApiModifierGroup[];
  stations?: PosCatalogueStation[];
  promotions: PosCataloguePromotion[];
}

interface ApiResponse {
  items: ApiItem[];
  total: number;
  nextCursor?: string | null;
}

function auth(session: Session): { token: string; tenantId: string } {
  return { token: session.token, tenantId: session.user.tenantId };
}

function toVariant(v: ApiVariant): PosCatalogueVariant {
  return {
    id: v.id,
    sku: v.sku,
    name: v.name,
    unitPrice: Number(v.unitPrice),
    isDefault: v.isDefault,
    isActive: v.isActive,
  };
}

function toOption(o: ApiOption): PosCatalogueOption {
  return {
    id: o.id,
    name: o.name,
    priceDelta: Number(o.priceDelta),
    isActive: o.isActive,
  };
}

function toModifierGroup(g: ApiModifierGroup): PosCatalogueModifierGroup {
  return {
    id: g.id,
    name: g.name,
    selection: g.selection,
    minSelections: g.minSelections,
    maxSelections: g.maxSelections,
    role: g.role,
    options: g.options.map(toOption),
  };
}

function toItem(i: ApiItem): PosCatalogueItem {
  return {
    id: i.id,
    name: i.name,
    description: i.description,
    imageUrl: i.imageUrl,
    unitPrice: i.unitPrice != null ? Number(i.unitPrice) : null,
    prepMinutes: i.prepMinutes ?? null,
    dietaryTags: i.dietaryTags ?? [],
    foodType: i.foodType ?? null,
    category: i.category,
    subcategory: i.subcategory,
    hasVariants: i.hasVariants,
    variants: (i.variants ?? []).map(toVariant),
    modifierGroups: (i.modifierGroups ?? []).map(toModifierGroup),
    stations: i.stations ?? [],
    promotions: i.promotions,
  };
}

/**
 * Fetch the POS-sellable catalogue for a branch.
 *
 * The query string is built by hand rather than via URLSearchParams so
 * omitted filters produce a clean URL (`?branchId=X` rather than
 * `?branchId=X&channel=`) — the backend treats empty strings the same as
 * absent, but a clean URL reads better in devtools and does not vary the
 * cache key.
 */
export async function fetchPosCatalogue(
  session: Session,
  query: PosCatalogueQuery,
): Promise<PosCatalogueResponse> {
  const params: string[] = [`branchId=${encodeURIComponent(query.branchId)}`];
  if (query.channel) params.push(`channel=${encodeURIComponent(query.channel)}`);
  if (query.foodType) params.push(`foodType=${encodeURIComponent(query.foodType)}`);
  if (query.search) params.push(`search=${encodeURIComponent(query.search)}`);
  if (query.limit != null) params.push(`limit=${query.limit}`);
  if (query.cursor) params.push(`cursor=${encodeURIComponent(query.cursor)}`);
  // D62: the one POS read model. The legacy /restaurant/pos-catalogue alias
  // still answers (with Deprecation headers) until its sunset; this client
  // moved on the day the successor shipped.
  const res = await api.get<ApiResponse>(`/products/sellable?${params.join('&')}`, auth(session));
  return { items: res.items.map(toItem), total: res.total, nextCursor: res.nextCursor ?? null };
}
