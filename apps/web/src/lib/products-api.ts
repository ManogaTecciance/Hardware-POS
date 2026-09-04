import { api, authorizedFetch } from './api';
import type { Session } from './auth';

export type ProductSyncStatus = 'NOT_SYNCED' | 'PENDING' | 'SYNCING' | 'SYNCED' | 'FAILED';

/** QuickBooks item types (mirrors the QBO Products & Services template). */
export type ProductItemType = 'Inventory' | 'NonInventory' | 'Service';

/**
 * A product as managed in the POS. Mirrors the QuickBooks Products & Services
 * fields (name, category, item type, SKU, sales description/price, purchase
 * description/cost, accounts, quantity on hand + as-of date, reorder point)
 * plus system fields (active flag, sync metadata).
 */
export interface ManagedProduct {
  id: string;
  name: string;
  type: ProductItemType;
  sku: string | null;
  /** Sales description — appears on sales forms and receipts. */
  description: string | null;
  categoryId: string | null;
  subcategoryId: string | null;
  /** Sales price/rate. */
  unitPrice: number;
  /** QBO income account name (auto-resolved on sync; read-only). */
  incomeAccount: string | null;
  /** Purchase description — what vendors see on purchase forms. */
  purchaseDescription: string | null;
  /** Purchase cost. */
  costPrice: number | null;
  /** QBO expense account name (auto-resolved on sync; read-only). */
  expenseAccount: string | null;
  quantityOnHand: number;
  /** The date the quantity on hand was counted. */
  quantityAsOfDate: string | null;
  /** Reorder point. */
  reorderLevel: number | null;
  /** QBO inventory asset account name (auto-resolved; read-only). */
  inventoryAssetAccount: string | null;
  /** POS-side product photo (S3) — never pushed to QuickBooks. */
  imageUrl: string | null;
  isActive: boolean;
  /** D101 — read back so the edit wizard can round-trip it. */
  taxable: boolean;
  quickbooksItemId: string | null;
  syncStatus: ProductSyncStatus;
  lastSyncedAt: string | null;
  /**
   * True once the product has any active variants (D44). Wizards use this to
   * decide between the simple single-SKU form and the matrix editor without
   * having to re-fetch the variants list first.
   */
  hasVariants: boolean;
  /**
   * Weighted-average cost across all branches for the parent product. Null on a
   * fresh Inventory item until the first receipt lands.
   */
  averageCost: number | null;
  /**
   * D44 — active variants, and the span of their prices.
   *
   * Once `hasVariants` is true the parent `unitPrice` and `sku` are legacy
   * fallbacks the schema says are "not read": the variant rows own them. Screens
   * that showed `unitPrice` were therefore rendering Rs 0.00 against every
   * variant product. Read these instead — see `variantPriceLabel`.
   *
   * `variantCount` is 0 and both bounds are null for a legacy single-SKU product.
   * Optional so a response predating the aggregate degrades to the old reading
   * rather than to `undefined` arithmetic.
   */
  variantCount?: number;
  variantPriceMin?: number | null;
  variantPriceMax?: number | null;
  /**
   * D64 — domain attributes, keyed per the tenant descriptor's attribute
   * schema (`GET /products/attribute-schema`). `{}` for every tenant whose
   * domain declares none.
   */
  attributes: Record<string, unknown>;
}

export interface ProductsPage {
  items: ManagedProduct[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ProductsQuery {
  page?: number;
  pageSize?: number;
  search?: string;
  categoryId?: string;
  subcategoryId?: string;
  isActive?: 'true' | 'false';
  type?: ProductItemType;
  syncStatus?: ProductSyncStatus;
  stockStatus?: 'IN' | 'OUT' | 'LOW';
}

export interface ProductInput {
  name: string;
  type?: ProductItemType;
  sku?: string | null;
  description?: string | null;
  categoryId?: string | null;
  subcategoryId?: string | null;
  unitPrice: number;
  purchaseDescription?: string | null;
  costPrice?: number | null;
  quantityOnHand?: number;
  quantityAsOfDate?: string | null;
  reorderLevel?: number | null;
  isActive?: boolean;
  /**
   * D101 (3.13) — whether the product attracts tax. Omitted means TAXABLE: the
   * server defaults it to true, so a client that never learned about this field
   * cannot zero-rate a product by silence.
   */
  taxable?: boolean;
  /**
   * URL for a POS-side photo that was pre-uploaded via `POST /products/image`
   * before the product existed (Add Product wizard, D44). Once created, use
   * `uploadProductImage(id, file)` for replacements — the pre-create endpoint
   * is one-shot.
   */
  imageUrl?: string | null;
  /**
   * D45 — Restaurant Product wizard fields. Backend accepts them on every
   * tenant; Retail tenants leave them null / empty and they don't render
   * anywhere. Sent through so a Restaurant tenant's Category (Food /
   * Beverage / Dessert), prep-time, and dietary tags round-trip.
   */
  foodType?: 'FOOD' | 'BEVERAGE' | 'DESSERT' | null;
  prepMinutes?: number | null;
  dietaryTags?: string[];
  /**
   * D64 — domain attributes. REPLACE semantics: when present the object is
   * the whole stored document; omit the key to leave it unchanged. Only sent
   * when the tenant's attribute schema is non-empty.
   */
  attributes?: Record<string, string | number | boolean>;
}

export interface Category {
  id: string;
  name: string;
  productCount?: number;
}

/** A subcategory nested under a category. */
export interface Subcategory {
  id: string;
  categoryId: string;
  name: string;
  slug: string;
  description: string | null;
  imageUrl: string | null;
  sortOrder: number;
  isActive: boolean;
  productCount: number;
}

/** A category with its nested subcategories (the `/categories` tree shape). */
export interface CategoryNode {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  imageUrl: string | null;
  sortOrder: number;
  isActive: boolean;
  quickbooksItemId: string | null;
  productCount: number;
  subcategoryCount: number;
  subcategories: Subcategory[];
}

export interface CategoryInput {
  name: string;
  slug?: string;
  description?: string | null;
  imageUrl?: string | null;
  sortOrder?: number;
}

export interface CategoryUpdate {
  name?: string;
  description?: string | null;
  sortOrder?: number;
  isActive?: boolean;
}

export interface SubcategoryInput {
  categoryId: string;
  name: string;
  slug?: string;
  description?: string | null;
  sortOrder?: number;
}

export interface SubcategoryUpdate {
  name?: string;
  description?: string | null;
  sortOrder?: number;
  isActive?: boolean;
}

/** Raw product JSON (decimals arrive as strings). */
type ApiProduct = Omit<
  ManagedProduct,
  'unitPrice' | 'costPrice' | 'quantityOnHand' | 'reorderLevel' | 'averageCost' | 'hasVariants'
> & {
  unitPrice: string | number;
  costPrice: string | number | null;
  quantityOnHand: string | number;
  reorderLevel: string | number | null;
  averageCost?: string | number | null;
  hasVariants?: boolean;
};

function auth(session: Session): { token: string; tenantId: string } {
  return { token: session.token, tenantId: session.user.tenantId };
}

/** Origin serving uploaded images (API base URL without the `/v1` version suffix). */
export function apiOrigin(): string {
  return api.baseUrl.replace(/\/v\d+\/?$/, '');
}

/** Resolve a stored image URL (`/uploads/..`) to an absolute URL the browser can load. */
export function resolveImageUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  // Absolute and local-preview URLs (object/data URLs) pass through untouched.
  if (/^(https?:\/\/|blob:|data:)/.test(url)) return url;
  return `${apiOrigin()}${url}`;
}

function toManaged(p: ApiProduct): ManagedProduct {
  return {
    ...p,
    unitPrice: Number(p.unitPrice),
    costPrice: p.costPrice != null ? Number(p.costPrice) : null,
    quantityOnHand: Number(p.quantityOnHand),
    reorderLevel: p.reorderLevel != null ? Number(p.reorderLevel) : null,
    // hasVariants and averageCost are D44 additions; older responses may omit
    // them, so read defensively rather than blowing up during rollout.
    hasVariants: p.hasVariants ?? false,
    averageCost: p.averageCost != null ? Number(p.averageCost) : null,
  };
}

function buildQuery(q: ProductsQuery): string {
  const params = new URLSearchParams();
  params.set('page', String(q.page ?? 1));
  params.set('pageSize', String(q.pageSize ?? 25));
  if (q.search) params.set('search', q.search);
  if (q.categoryId) params.set('categoryId', q.categoryId);
  if (q.subcategoryId) params.set('subcategoryId', q.subcategoryId);
  if (q.isActive) params.set('isActive', q.isActive);
  if (q.type) params.set('type', q.type);
  if (q.syncStatus) params.set('syncStatus', q.syncStatus);
  if (q.stockStatus) params.set('stockStatus', q.stockStatus);
  return params.toString();
}

export async function fetchProducts(session: Session, query: ProductsQuery = {}): Promise<ProductsPage> {
  const res = await api.get<{ items: ApiProduct[]; total: number; page: number; pageSize: number }>(
    `/products?${buildQuery(query)}`,
    auth(session),
  );
  return { ...res, items: res.items.map(toManaged) };
}

export async function fetchProduct(session: Session, id: string): Promise<ManagedProduct> {
  return toManaged(await api.get<ApiProduct>(`/products/${id}`, auth(session)));
}

export interface StockCounts {
  outOfStock: number;
  lowStock: number;
}

/**
 * Out-of-stock and low-stock counts straight from the server, using the same
 * `stockStatus` filter the products table applies (Inventory items only; LOW
 * uses each product's reorder point). pageSize=1 keeps it cheap — we only read
 * the `total`. Keeps the dashboard alert counts in exact agreement with the
 * filtered table, at any catalog size.
 */
export async function fetchStockCounts(session: Session): Promise<StockCounts> {
  const [out, low] = await Promise.all([
    fetchProducts(session, { stockStatus: 'OUT', isActive: 'true', pageSize: 1 }),
    fetchProducts(session, { stockStatus: 'LOW', isActive: 'true', pageSize: 1 }),
  ]);
  return { outOfStock: out.total, lowStock: low.total };
}

export async function createProduct(session: Session, input: ProductInput): Promise<ManagedProduct> {
  return toManaged(await api.post<ApiProduct>('/products', input, auth(session)));
}

export async function updateProduct(
  session: Session,
  id: string,
  input: Partial<ProductInput>,
): Promise<ManagedProduct> {
  return toManaged(await api.patch<ApiProduct>(`/products/${id}`, input, auth(session)));
}

export async function deactivateProduct(session: Session, id: string): Promise<ManagedProduct> {
  return toManaged(await api.del<ApiProduct>(`/products/${id}`, auth(session)));
}

export async function setProductActive(
  session: Session,
  id: string,
  isActive: boolean,
): Promise<ManagedProduct> {
  return updateProduct(session, id, { isActive });
}

/** Upload a product image (multipart). Returns the updated product. */
export async function uploadProductImage(
  session: Session,
  id: string,
  file: File,
): Promise<ManagedProduct> {
  const form = new FormData();
  form.append('file', file);
  const res = await authorizedFetch(`/products/${id}/image`, session, {
    method: 'POST',
    body: form,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const message =
      json?.message ?? (res.status === 413 ? 'Image is too large (max 5MB)' : 'Image upload failed');
    throw new Error(Array.isArray(message) ? message.join(', ') : message);
  }
  return toManaged((json?.data ?? json) as ApiProduct);
}

export async function deleteProductImage(session: Session, id: string): Promise<ManagedProduct> {
  return toManaged(await api.del<ApiProduct>(`/products/${id}/image`, auth(session)));
}

/**
 * Upload a product photo BEFORE the product exists (Add Product wizard, D44).
 * Symmetric to the menu-item wizard's pre-create image endpoint: hands back the
 * stored URL, which the wizard then passes as `imageUrl` on the create call.
 * An orphan upload (wizard abandoned) is swept by the storage GC follow-up.
 */
export async function uploadProductImagePreCreate(
  session: Session,
  file: File,
): Promise<{ imageUrl: string }> {
  const form = new FormData();
  form.append('file', file);
  const res = await authorizedFetch('/products/image', session, {
    method: 'POST',
    body: form,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const message =
      json?.message ?? (res.status === 413 ? 'Image is too large (max 5MB)' : 'Image upload failed');
    throw new Error(Array.isArray(message) ? message.join(', ') : message);
  }
  return (json?.data ?? json) as { imageUrl: string };
}

export type ReportFormat = 'pdf' | 'xlsx';

/**
 * Download a stock report (PDF or Excel) covering ALL products that match the
 * given filters — not just the currently visible page. Triggers a browser
 * file download.
 */
export async function downloadProductsReport(
  session: Session,
  query: Omit<ProductsQuery, 'page' | 'pageSize'>,
  format: ReportFormat,
): Promise<void> {
  const params = new URLSearchParams();
  params.set('format', format);
  if (query.search) params.set('search', query.search);
  if (query.categoryId) params.set('categoryId', query.categoryId);
  if (query.subcategoryId) params.set('subcategoryId', query.subcategoryId);
  if (query.isActive) params.set('isActive', query.isActive);
  if (query.type) params.set('type', query.type);
  if (query.syncStatus) params.set('syncStatus', query.syncStatus);
  if (query.stockStatus) params.set('stockStatus', query.stockStatus);

  const res = await authorizedFetch(`/products/report?${params.toString()}`, session);
  if (!res.ok) {
    const json = await res.json().catch(() => null);
    const message = json?.message ?? 'Export failed';
    throw new Error(Array.isArray(message) ? message.join(', ') : message);
  }
  const blob = await res.blob();
  const disposition = res.headers.get('Content-Disposition') ?? '';
  const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? `stock-report.${format}`;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Trigger a browser download of a fetched blob with a filename. */
function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ── Bulk import (two-phase: preview → review → commit) ────────────────────────

/** A parsed + validated row from the uploaded sheet (nothing created yet). */
export interface ParsedProductRow {
  rowNumber: number;
  name: string;
  type: ProductItemType;
  sku: string | null;
  categoryPath: string | null;
  description: string | null;
  unitPrice: number;
  purchaseDescription: string | null;
  costPrice: number | null;
  quantityOnHand: number;
  quantityAsOfDate: string | null;
  reorderLevel: number | null;
  incomeAccount: string | null;
  expenseAccount: string | null;
  inventoryAssetAccount: string | null;
  matchStatus: 'create' | 'update';
  errors: string[];
}

export interface ImportCommitResult {
  rowNumber: number;
  productId: string | null;
  outcome: 'created' | 'updated' | 'failed';
  error?: string;
}

export interface ImportCommitSummary {
  created: number;
  updated: number;
  failed: number;
  results: ImportCommitResult[];
}

/** Download the blank .xlsx import template. */
export async function downloadProductTemplate(session: Session): Promise<void> {
  const res = await authorizedFetch('/products/import/template', session);
  if (!res.ok) throw new Error('Could not download the template');
  saveBlob(await res.blob(), 'product-import-template.xlsx');
}

/** Upload a sheet and get back the parsed rows to review (no products created). */
export async function previewProductImport(
  session: Session,
  file: File,
): Promise<ParsedProductRow[]> {
  const form = new FormData();
  form.append('file', file);
  const res = await authorizedFetch('/products/import/preview', session, {
    method: 'POST',
    body: form,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const message =
      json?.message ?? (res.status === 413 ? 'File is too large (max 10MB)' : 'Could not read file');
    throw new Error(Array.isArray(message) ? message.join(', ') : message);
  }
  return (json?.data ?? json) as ParsedProductRow[];
}

/** Commit the reviewed rows; returns each row's product id (for image upload). */
export async function commitProductImport(
  session: Session,
  rows: ParsedProductRow[],
): Promise<ImportCommitSummary> {
  return api.post<ImportCommitSummary>('/products/import/commit', { rows }, auth(session));
}

export async function syncProductToQuickBooks(
  session: Session,
  id: string,
): Promise<ManagedProduct> {
  return toManaged(await api.post<ApiProduct>(`/products/${id}/sync-to-quickbooks`, undefined, auth(session)));
}

export async function fetchCategories(session: Session): Promise<Category[]> {
  return api.get<Category[]>('/categories', auth(session));
}

// ── Category tree + management ────────────────────────────────────────────────

/** Fetch the full category tree (categories with nested subcategories). */
export async function fetchCategoryTree(
  session: Session,
  activeOnly = false,
): Promise<CategoryNode[]> {
  return api.get<CategoryNode[]>(`/categories${activeOnly ? '?active=true' : ''}`, auth(session));
}

export async function createCategory(session: Session, input: CategoryInput): Promise<CategoryNode> {
  return api.post<CategoryNode>('/product-categories', input, auth(session));
}

export async function updateCategory(
  session: Session,
  id: string,
  input: CategoryUpdate,
): Promise<CategoryNode> {
  return api.patch<CategoryNode>(`/product-categories/${id}`, input, auth(session));
}

export async function deactivateCategory(session: Session, id: string): Promise<CategoryNode> {
  return api.post<CategoryNode>(`/product-categories/${id}/deactivate`, undefined, auth(session));
}

export async function reactivateCategory(session: Session, id: string): Promise<CategoryNode> {
  return api.post<CategoryNode>(`/product-categories/${id}/reactivate`, undefined, auth(session));
}

export async function reorderCategories(
  session: Session,
  orderedIds: string[],
): Promise<CategoryNode[]> {
  return api.post<CategoryNode[]>('/product-categories/reorder', { orderedIds }, auth(session));
}

export async function createSubcategory(
  session: Session,
  input: SubcategoryInput,
): Promise<Subcategory> {
  return api.post<Subcategory>('/product-subcategories', input, auth(session));
}

export async function updateSubcategory(
  session: Session,
  id: string,
  input: SubcategoryUpdate,
): Promise<Subcategory> {
  return api.patch<Subcategory>(`/product-subcategories/${id}`, input, auth(session));
}

export async function deactivateSubcategory(session: Session, id: string): Promise<Subcategory> {
  return api.post<Subcategory>(`/product-subcategories/${id}/deactivate`, undefined, auth(session));
}

export async function reactivateSubcategory(session: Session, id: string): Promise<Subcategory> {
  return api.post<Subcategory>(`/product-subcategories/${id}/reactivate`, undefined, auth(session));
}

export async function moveSubcategory(
  session: Session,
  id: string,
  categoryId: string,
): Promise<Subcategory> {
  return api.post<Subcategory>(`/product-subcategories/${id}/move`, { categoryId }, auth(session));
}

export async function fetchSubcategories(
  session: Session,
  categoryId: string,
): Promise<Subcategory[]> {
  return api.get<Subcategory[]>(`/product-subcategories?categoryId=${categoryId}`, auth(session));
}
