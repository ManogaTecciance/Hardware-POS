'use client';

import { DEFAULT_CURRENCY, DEFAULT_TIME_ZONE } from '@hardware-pos/shared';
import * as React from 'react';

import { api } from './api';
import type { Session } from './auth';

export interface ClientProduct {
  id: string;
  name: string;
  sku: string | null;
  /** QuickBooks item type: Inventory | NonInventory | Service. */
  type: string;
  categoryName: string;
  subcategoryId: string | null;
  subcategoryName: string | null;
  unitPrice: number;
  quantityOnHand: number;
  /** Reorder point (null when not set) — drives the POS low-stock badge. */
  reorderLevel: number | null;
  imageUrl: string | null;
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

interface ApiProduct {
  id: string;
  name: string;
  sku: string | null;
  type: string;
  categoryId: string | null;
  subcategoryId: string | null;
  unitPrice: string | number;
  quantityOnHand: string | number;
  reorderLevel: string | number | null;
  imageUrl: string | null;
}

interface ApiSubcategory {
  id: string;
  name: string;
  isActive?: boolean;
}

interface ApiCategory {
  id: string;
  name: string;
  isActive?: boolean;
  subcategories?: ApiSubcategory[];
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
  /** Re-fetch the catalog (e.g. after the API comes back up). */
  reload: () => void;
}

function deriveCategories(products: ClientProduct[]): string[] {
  return Array.from(new Set(products.map((p) => p.categoryName))).sort();
}

function normalizeApi(
  p: ApiProduct,
  catNames: Map<string, string>,
  subNames: Map<string, string>,
): ClientProduct {
  return {
    id: p.id,
    name: p.name,
    sku: p.sku,
    type: p.type,
    categoryName: (p.categoryId && catNames.get(p.categoryId)) || 'Uncategorized',
    subcategoryId: p.subcategoryId ?? null,
    subcategoryName: (p.subcategoryId && subNames.get(p.subcategoryId)) || null,
    unitPrice: Number(p.unitPrice),
    quantityOnHand: Number(p.quantityOnHand),
    reorderLevel: p.reorderLevel != null ? Number(p.reorderLevel) : null,
    imageUrl: p.imageUrl,
  };
}

/** The API caps `pageSize` at this value, so larger catalogs need paging. */
const MAX_PAGE_SIZE = 200;

/**
 * Fetch the whole product catalog for the POS by paging through all results.
 * The POS filters/searches client-side over this list, so it must load every
 * product — a single capped request would silently drop everything past the
 * first page (products sorted alphabetically beyond the cap wouldn't appear).
 */
async function fetchAllProducts(auth: { token: string; tenantId: string }): Promise<ApiProduct[]> {
  const first = await api.get<{ items: ApiProduct[]; total: number }>(
    `/products?page=1&pageSize=${MAX_PAGE_SIZE}`,
    auth,
  );
  const items = [...first.items];
  const totalPages = Math.ceil(first.total / MAX_PAGE_SIZE);
  if (totalPages > 1) {
    const rest = await Promise.all(
      Array.from({ length: totalPages - 1 }, (_, i) =>
        api.get<{ items: ApiProduct[] }>(`/products?page=${i + 2}&pageSize=${MAX_PAGE_SIZE}`, auth),
      ),
    );
    for (const page of rest) items.push(...page.items);
  }
  return items;
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

  React.useEffect(() => {
    let cancelled = false;
    const auth = { token, tenantId };
    setData((prev) => ({ ...prev, loading: true, error: null }));

    (async () => {
      try {
        const [productItems, cats, settings] = await Promise.all([
          fetchAllProducts(auth),
          api.get<ApiCategory[]>('/categories', auth),
          api.get<PosSettings>('/settings', auth),
        ]);
        if (cancelled) return;
        const catNames = new Map(cats.map((c) => [c.id, c.name]));
        const subNames = new Map<string, string>();
        for (const c of cats) {
          for (const s of c.subcategories ?? []) subNames.set(s.id, s.name);
        }
        const categoryTree: CatalogCategory[] = cats
          .filter((c) => c.isActive !== false)
          .map((c) => ({
            id: c.id,
            name: c.name,
            subcategories: (c.subcategories ?? [])
              .filter((s) => s.isActive !== false)
              .map((s) => ({ id: s.id, name: s.name })),
          }));
        const products = productItems.map((p) => normalizeApi(p, catNames, subNames));
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
  }, [token, tenantId, refreshKey]);

  return React.useMemo(() => ({ ...data, reload }), [data, reload]);
}
