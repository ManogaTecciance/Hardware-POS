'use client';

import { DEFAULT_CURRENCY } from '@hardware-pos/shared';
import * as React from 'react';

import { api } from './api';
import type { Session } from './auth';

/** D99 — one sellable size/pack of a product, as the till needs it. */
export interface ClientVariant {
  id: string;
  sku: string;
  /** D99 — the scannable code. Only variants have one; `Product` has no column. */
  barcode: string | null;
  /** "Black / Medium", or the SKU when the variant carries no options. */
  name: string;
  unitPrice: number;
  /** The variant the POS quick-adds when the operator taps the card (D45). */
  isDefault: boolean;
  /** Branch stock for this variant. `null` when the tenant tracks no stock. */
  quantityOnHand: number | null;
  stockState: StockState;
}

export type StockState = 'IN_STOCK' | 'LOW' | 'OUT' | 'UNTRACKED';

export interface ClientProduct {
  id: string;
  name: string;
  sku: string | null;
  /** QuickBooks item type: Inventory | NonInventory | Service. */
  type: string;
  categoryName: string;
  subcategoryId: string | null;
  subcategoryName: string | null;
  /**
   * Product-level price. **Null when variants own the price** — the read model
   * says so explicitly rather than repeating a number that means nothing for a
   * variant product, so a caller that ignores variants cannot quietly charge it.
   */
  unitPrice: number | null;
  /**
   * Branch stock. For a product with variants this is the **sum across sizes**,
   * rolled up by the server (1c.6) from the variant rows rather than read from
   * `Product.quantityOnHand`, which is a mirror and had drifted.
   *
   * Informative, never a limit: the sell cap comes from `stockCap(product,
   * variant)`, which asks the chosen size.
   */
  quantityOnHand: number;
  /**
   * The server's stock classification — the same field, computed the same way,
   * that each variant carries.
   *
   * This replaces a client-side `reorderLevel` comparison. The read model does
   * not expose a reorder point, so that field was mapped to null unconditionally
   * and every low-stock badge in the app had been silently dead since 1c.1. The
   * server already classifies; the till reads its answer rather than re-deriving
   * one from a threshold it cannot see.
   */
  stockState: StockState;
  imageUrl: string | null;
  /** D99 — empty for a single-SKU product; the sizes to choose from otherwise. */
  variants: ClientVariant[];
}

export interface ClientCustomer {
  id: string;
  name: string;
}

export interface CatalogSubcategory {
  id: string;
  name: string;
}

/** A category with its subcategories, for the POS category + subcategory filter. */
export interface CatalogCategory {
  id: string;
  name: string;
  subcategories: CatalogSubcategory[];
}

export interface PosSettings {
  currency: string;
  taxRatePercent: number;
}

/**
 * `GET /products/sellable` — the POS read model (D62).
 *
 * Money and quantities arrive as decimal STRINGS, not numbers: the server keeps
 * them in `Prisma.Decimal` (D59) and serialising through a float is exactly the
 * boundary that rule exists to prevent. They are parsed once, here.
 */
interface ApiSellableItem {
  id: string;
  name: string;
  /** Null for a variant product — its SKUs live on the variants (D44). */
  sku: string | null;
  sellableKind: string;
  /** Null when variants own the price. */
  unitPrice: string | null;
  effectivePrice: string | null;
  category: { id: string; name: string } | null;
  subcategory: { id: string; name: string } | null;
  imageUrl: string | null;
  hasVariants: boolean;
  variants?: {
    id: string;
    sku: string;
    barcode: string | null;
    name: string;
    unitPrice: string;
    isDefault: boolean;
    isActive: boolean;
    availableQuantity: string | null;
    stockState: StockState;
  }[];
  availableQuantity?: string | null;
  stockState?: StockState;
}

interface ApiSellableResponse {
  items: ApiSellableItem[];
  total: number;
  nextCursor: string | null;
}

const DEFAULT_SETTINGS: PosSettings = { currency: DEFAULT_CURRENCY, taxRatePercent: 0 };

export interface CheckoutData {
  loading: boolean;
  /** Non-null when the catalog failed to load from the API. */
  error: string | null;
  products: ClientProduct[];
  categories: string[];
  /** Category tree (id, name, subcategories) for the POS category + subcategory filter. */
  categoryTree: CatalogCategory[];
  settings: PosSettings;
  /** Re-fetch the catalog (e.g. after the API comes back up). */
  reload: () => void;
}

/**
 * What price to show for a product card.
 *
 * A variant product has no price of its own (D99): the read model reports null
 * because its variants own the number. Until the card renders a range or a
 * "from" price (1c.4), show the cheapest active variant — the honest answer to
 * "what does this start at" — and fall back to 0 only when there is nothing to
 * price at all.
 */
export function displayPrice(p: ClientProduct): number {
  if (p.unitPrice != null) return p.unitPrice;
  if (p.variants.length === 0) return 0;
  return Math.min(...p.variants.map((v) => v.unitPrice));
}

function deriveCategories(products: ClientProduct[]): string[] {
  return Array.from(new Set(products.map((p) => p.categoryName))).sort();
}

function normalizeApi(item: ApiSellableItem): ClientProduct {
  const tracks = item.stockState !== undefined && item.stockState !== 'UNTRACKED';
  return {
    id: item.id,
    name: item.name,
    // 1c.1 set this to null because the read model did not expose a SKU, which
    // silently broke barcode scanning: `findBySku` matched against it and could
    // never hit. The compiler said nothing — the field was already
    // `string | null`. 1c.5 restored the field server-side; this reads it.
    sku: item.sku,
    // `trackInventory` was derived from the QuickBooks item type; the read model
    // answers the same question directly with UNTRACKED, which also covers a
    // SERVICE and a COMPOSED_ITEM without the till knowing either concept.
    type: tracks ? 'Inventory' : 'Service',
    categoryName: item.category?.name ?? 'Uncategorized',
    subcategoryId: item.subcategory?.id ?? null,
    subcategoryName: item.subcategory?.name ?? null,
    unitPrice: item.unitPrice != null ? Number(item.unitPrice) : null,
    quantityOnHand: item.availableQuantity != null ? Number(item.availableQuantity) : 0,
    stockState: item.stockState ?? 'UNTRACKED',
    imageUrl: item.imageUrl,
    variants: (item.variants ?? [])
      .filter((v) => v.isActive)
      .map((v) => ({
        id: v.id,
        sku: v.sku,
        barcode: v.barcode,
        name: v.name,
        unitPrice: Number(v.unitPrice),
        isDefault: v.isDefault,
        quantityOnHand: v.availableQuantity != null ? Number(v.availableQuantity) : null,
        stockState: v.stockState,
      })),
  };
}

/** The API caps `limit` at this value, so larger catalogs need paging. */
const MAX_PAGE_SIZE = 200;

/**
 * Fetch the whole sellable catalogue by following the cursor.
 *
 * The POS filters and searches client-side over this list, so it must load every
 * page — stopping at the first would silently drop everything alphabetically
 * beyond the cap. `/products/sellable` pages by opaque cursor rather than by page
 * number, so the pages cannot be requested in parallel the way the old numbered
 * endpoint allowed; each response names the next.
 *
 * `MAX_PAGES` is a stop, not a limit: a server that returned a non-advancing
 * cursor would otherwise spin here forever.
 */
const MAX_PAGES = 100;

async function fetchAllSellable(
  auth: { token: string; tenantId: string },
  branchId: string,
): Promise<ApiSellableItem[]> {
  const items: ApiSellableItem[] = [];
  let cursor: string | null = null;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const qs = new URLSearchParams({
      branchId,
      // COUNTER is the retail channel; it decides channel-scoped pricing and
      // which promotions are considered live for this till.
      channel: 'COUNTER',
      limit: String(MAX_PAGE_SIZE),
    });
    if (cursor) qs.set('cursor', cursor);

    const res: ApiSellableResponse = await api.get<ApiSellableResponse>(
      `/products/sellable?${qs.toString()}`,
      auth,
    );
    items.push(...res.items);
    if (!res.nextCursor) return items;
    cursor = res.nextCursor;
  }
  return items;
}

/**
 * The category tree, derived from what is actually sellable.
 *
 * Previously a second call to `/categories`, joined to products client-side. That
 * listed every category and subcategory the tenant had defined, including ones
 * with nothing sellable in them — so the till could show a chip that filtered to
 * an empty grid. Deriving it from the catalogue means a chip always has something
 * behind it.
 */
function deriveCategoryTree(products: ClientProduct[]): CatalogCategory[] {
  const byName = new Map<string, Map<string, string>>();
  for (const p of products) {
    if (!byName.has(p.categoryName)) byName.set(p.categoryName, new Map());
    if (p.subcategoryId && p.subcategoryName) {
      byName.get(p.categoryName)!.set(p.subcategoryId, p.subcategoryName);
    }
  }
  return [...byName.entries()]
    .map(([name, subs]) => ({
      // The read model gives no category id at tree level, and the till filters
      // by name — the id is carried on the product itself where it is needed.
      id: name,
      name,
      subcategories: [...subs.entries()]
        .map(([id, subName]) => ({ id, name: subName }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Loads catalog data for the checkout screen from the backend product API. */
export function useCheckoutData(session: Session): CheckoutData {
  const [refreshKey, setRefreshKey] = React.useState(0);
  const reload = React.useCallback(() => setRefreshKey((k) => k + 1), []);

  const [data, setData] = React.useState<Omit<CheckoutData, 'reload'>>({
    loading: true,
    error: null,
    products: [],
    categories: [],
    categoryTree: [],
    settings: DEFAULT_SETTINGS,
  });

  const token = session.token;
  const tenantId = session.user.tenantId;
  const branchId = session.branchId;

  React.useEffect(() => {
    let cancelled = false;
    const auth = { token, tenantId };
    setData((prev) => ({ ...prev, loading: true, error: null }));

    (async () => {
      try {
        // `/products/sellable` is branch-scoped: stock and channel pricing are
        // per branch, so there is no sensible tenant-wide answer. A session with
        // no branch cannot complete a sale either — `saleLocation()` already
        // throws — so failing here states the same requirement earlier and more
        // clearly than an empty grid would.
        if (!branchId) {
          throw new Error('No branch assigned to this session — the POS needs one to load stock');
        }
        const [items, settings] = await Promise.all([
          fetchAllSellable(auth, branchId),
          api.get<PosSettings>('/settings', auth),
        ]);
        if (cancelled) return;
        const products = items.map(normalizeApi);
        const categoryTree = deriveCategoryTree(products);
        setData({
          loading: false,
          error: null,
          products,
          categories: deriveCategories(products),
          categoryTree,
          settings,
        });
      } catch (err) {
        if (cancelled) return;
        setData({
          loading: false,
          error: err instanceof Error ? err.message : 'Failed to load the product catalog',
          products: [],
          categories: [],
          categoryTree: [],
          settings: DEFAULT_SETTINGS,
        });
      }
    })();

    return () => {
      cancelled = true;
    };
    // `branchId` belongs here: the catalogue is branch-scoped now, so switching
    // branch must refetch rather than keep showing the old branch's stock.
  }, [token, tenantId, branchId, refreshKey]);

  return React.useMemo(() => ({ ...data, reload }), [data, reload]);
}
