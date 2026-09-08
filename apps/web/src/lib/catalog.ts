'use client';

import { DEFAULT_CURRENCY, DEFAULT_TIME_ZONE, type PromotionRule } from '@hardware-pos/shared';
import * as React from 'react';

import { api } from './api';
import type { Session } from './auth';

/** D120 — one sellable size/pack of a product, as the till needs it. */
export interface ClientVariant {
  id: string;
  sku: string;
  /** D120 — the scannable code. Only variants have one; `Product` has no column. */
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

/**
 * D134 (`6.2`) — mirrors the Prisma `QuantityType` enum.
 *
 * Declared here rather than imported: `@hardware-pos/database` is a server
 * package and the browser cannot load it. Same idiom as `StockState` above.
 */
export type ClientQuantityType = 'WHOLE' | 'DECIMAL';

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
  /**
   * D122 (3.14) — whether the product attracts tax.
   *
   * The till needs it to preview the same total the server will charge. Absent
   * on a response from an API predating the field, and `?? true` keeps that
   * behaving as it always did rather than silently zero-rating.
   */
  taxable: boolean;
  /**
   * D134 (`6.2`) — `'WHOLE'` is sold by the piece, `'DECIMAL'` by weight or
   * measure.
   *
   * What the cart reads to decide whether to open the numpad. Absent on a
   * response predating the field, and `?? 'WHOLE'` keeps that behaving as it
   * always did — the same shape `taxable` uses above, for the same reason.
   */
  quantityType: ClientQuantityType;
  /** D134b — `'kg'`, `'L'`. Null for a WHOLE product, which has no unit. */
  unitOfMeasure: string | null;
  /** D120 — empty for a single-SKU product; the sizes to choose from otherwise. */
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
  /**
   * Shop timezone. The POS needs it because the API judges an invoice date
   * against the SHOP's calendar day — a till whose browser is a day ahead would
   * otherwise offer a date the server rejects.
   */
  timezone: string;
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
  /**
   * The QuickBooks item type (Inventory | NonInventory | Service); absent on
   * responses predating D136. It never decides stock — `stockState` does — it
   * only decides how an untracked item is labelled.
   */
  type?: string;
  /** Null when variants own the price. */
  unitPrice: string | null;
  effectivePrice: string | null;
  category: { id: string; name: string } | null;
  subcategory: { id: string; name: string } | null;
  imageUrl: string | null;
  hasVariants: boolean;
  /** D122 (3.14); absent on responses predating the field. */
  taxable?: boolean;
  /** D134 (`6.2`); absent on responses predating the field. */
  quantityType?: ClientQuantityType;
  unitOfMeasure?: string | null;
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

/**
 * Wire → applier. The payload carries Decimals as strings because JSON numbers
 * cannot hold one safely; the applier works in plain numbers with cent rounding.
 * Converting in exactly one place keeps that boundary somewhere a reader can find.
 */
/**
 * Exported for test only. A wire mapper is where a field goes to die — 4.15 lost
 * `productName` here and D126 lost `minimumSpend` the same way — so this one is
 * asserted directly rather than through three layers of catalogue fetching.
 */
export function toPromotionRule(api: ApiPromotionRule): PromotionRule {
  const num = (v: string | null): number | null => (v === null ? null : Number(v));
  return {
    id: api.id,
    name: api.name,
    type: api.type as PromotionRule['type'],
    fixedPrice: num(api.fixedPrice),
    percentageOff: num(api.percentageOff),
    amountOff: num(api.amountOff),
    // D126 — the cart threshold. `?? null` because a server predating D126 omits
    // the field entirely, and `undefined` would read as "no threshold" and hand
    // the discount to every basket regardless of size.
    minimumSpend: num(api.minimumSpend ?? null),
    buyQuantity: api.buyQuantity,
    getQuantity: api.getQuantity,
    stackable: api.stackable,
    items: api.items.map((it) => ({
      productId: it.productId,
      role: it.role as PromotionRule['items'][number]['role'],
      quantity: it.quantity,
    })),
  };
}

/** D123 (4.3) — the priceable shape, as it arrives. Decimals are strings. */
export interface ApiPromotionRule {
  id: string;
  name: string;
  type: string;
  fixedPrice: string | null;
  percentageOff: string | null;
  amountOff: string | null;
  /** D126 — optional on the WIRE: a server predating D126 does not send it. */
  minimumSpend?: string | null;
  buyQuantity: number | null;
  getQuantity: number | null;
  stackable: boolean;
  items: { productId: string; role: string; quantity: number }[];
}

interface ApiSellableResponse {
  items: ApiSellableItem[];
  total: number;
  nextCursor: string | null;
  /** Absent on a response from an API predating 4.3 — treated as no promotions. */
  promotionRules?: ApiPromotionRule[];
}

const DEFAULT_SETTINGS: PosSettings = {
  currency: DEFAULT_CURRENCY,
  taxRatePercent: 0,
  timezone: DEFAULT_TIME_ZONE,
};

export interface CheckoutData {
  loading: boolean;
  /** Non-null when the catalog failed to load from the API. */
  error: string | null;
  products: ClientProduct[];
  categories: string[];
  /** Category tree (id, name, subcategories) for the POS category + subcategory filter. */
  categoryTree: CatalogCategory[];
  settings: PosSettings;
  /**
   * D123 (4.3) — the promotions eligible for this till, in the shape the shared
   * applier consumes. Empty when the API predates 4.3, so an older server simply
   * prices nothing rather than throwing.
   *
   * `ClientProduct.promotions` remains the BADGE. This is what makes the badge
   * chargeable, and 4.4 is where `computeTotals` starts reading it.
   */
  promotionRules: PromotionRule[];
  /** Re-fetch the catalog (e.g. after the API comes back up). */
  reload: () => void;
}

/**
 * What price to show for a product card.
 *
 * A variant product has no price of its own (D120): the read model reports null
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

export function normalizeApi(item: ApiSellableItem): ClientProduct {
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
    // The type is still read for the LABEL: main's tile badge says
    // "Non-Inventory" for a NonInventory item, and "Service" would be wrong
    // there (D136). An older server that sends no type gets the old collapse.
    type: tracks ? 'Inventory' : item.type === 'NonInventory' ? 'NonInventory' : 'Service',
    categoryName: item.category?.name ?? 'Uncategorized',
    subcategoryId: item.subcategory?.id ?? null,
    subcategoryName: item.subcategory?.name ?? null,
    unitPrice: item.unitPrice != null ? Number(item.unitPrice) : null,
    quantityOnHand: item.availableQuantity != null ? Number(item.availableQuantity) : 0,
    stockState: item.stockState ?? 'UNTRACKED',
    taxable: item.taxable ?? true,
    // D134 — an older server omits it, and WHOLE is what every product was
    // before the column existed. Never inferred from the name or the category.
    quantityType: item.quantityType ?? 'WHOLE',
    unitOfMeasure: item.unitOfMeasure ?? null,
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
): Promise<{ items: ApiSellableItem[]; promotionRules: ApiPromotionRule[] }> {
  const items: ApiSellableItem[] = [];
  /*
   * Every page repeats the same eligible set — one `isPromotionActive` pass per
   * request, not per page — so collect by id rather than concatenating. A
   * `BUNDLE_FIXED_PRICE` rule appended once per page would be applied once per
   * page too, and a bundle would discount three times on a three-page catalogue.
   */
  const rulesById = new Map<string, ApiPromotionRule>();
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
    for (const rule of res.promotionRules ?? []) rulesById.set(rule.id, rule);
    if (!res.nextCursor) return { items, promotionRules: [...rulesById.values()] };
    cursor = res.nextCursor;
  }
  return { items, promotionRules: [...rulesById.values()] };
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
    promotionRules: [],
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
        const [sellable, settings] = await Promise.all([
          fetchAllSellable(auth, branchId),
          api.get<PosSettings>('/settings', auth),
        ]);
        if (cancelled) return;
        const products = sellable.items.map(normalizeApi);
        const categoryTree = deriveCategoryTree(products);
        setData({
          loading: false,
          error: null,
          products,
          categories: deriveCategories(products),
          categoryTree,
          settings,
          promotionRules: sellable.promotionRules.map(toPromotionRule),
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
          // Unresolved is its own state: a failed load prices nothing rather
          // than guessing at an offer the server never confirmed (D31).
          promotionRules: [],
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
