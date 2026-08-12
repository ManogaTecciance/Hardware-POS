/**
 * Client for the product-variants + variations endpoints (D44).
 *
 * The backend exposes decimals as strings (Prisma `Decimal.toString()`) so the
 * wizard would silently store `"12.5"` where it expected `12.5`. Every hop
 * through this module normalises those to `number`, so callers work with the
 * same shape whether they got a value from a fresh POST or a cached list.
 *
 * The colon-suffixed `variants:batch` route is deliberate — it mirrors the
 * server's URL shape (Nest treats the `:batch` suffix as a literal segment
 * because it lacks a leading `:`). We do NOT URL-encode the colon.
 */

import { api, authorizedFetch } from '../api';
import type { Session } from '../auth';

// ── Types ────────────────────────────────────────────────────────────────────

export interface ProductVariationOption {
  id: string;
  name: string;
  position: number;
}

export interface ProductVariationDimension {
  id: string;
  name: string;
  position: number;
  options: ProductVariationOption[];
}

export interface ProductVariantOptionValue {
  dimensionId: string;
  optionId: string;
  dimensionName: string;
  optionName: string;
}

export interface ProductVariant {
  id: string;
  productId: string;
  sku: string;
  barcode: string | null;
  unitPrice: number;
  costPrice: number | null;
  averageCost: number | null;
  reorderLevel: number | null;
  imageUrl: string | null;
  position: number;
  isActive: boolean;
  optionValues: ProductVariantOptionValue[];
}

export interface VariantBranchInventory {
  branchId: string;
  branchName: string;
  quantityOnHand: number;
  averageCost: number | null;
  reorderLevel: number | null;
}

export interface VariantPurchaseLine {
  receiptId: string;
  receiptNumber: string;
  receivedAt: string;
  supplierId: string | null;
  supplierName: string | null;
  invoiceReference: string | null;
  grnReference: string | null;
  lotNumber: string | null;
  expiryDate: string | null;
  quantityReceived: number;
  unitCost: number;
}

// ── Raw wire shapes (decimals arrive as strings) ─────────────────────────────

interface ApiVariant {
  id: string;
  productId: string;
  sku: string;
  barcode: string | null;
  unitPrice: string | number;
  costPrice: string | number | null;
  averageCost: string | number | null;
  reorderLevel: string | number | null;
  imageUrl: string | null;
  position: number;
  isActive: boolean;
  optionValues: ProductVariantOptionValue[];
}

interface ApiVariantInventory {
  branchId: string;
  branchName: string;
  quantityOnHand: string | number;
  averageCost: string | number | null;
  reorderLevel: string | number | null;
}

interface ApiVariantPurchase {
  receiptId: string;
  receiptNumber: string;
  receivedAt: string;
  supplierId: string | null;
  supplierName: string | null;
  invoiceReference: string | null;
  grnReference: string | null;
  lotNumber: string | null;
  expiryDate: string | null;
  quantityReceived: string | number;
  unitCost: string | number;
}

function auth(session: Session): { token: string; tenantId: string } {
  return { token: session.token, tenantId: session.user.tenantId };
}

function toVariant(v: ApiVariant): ProductVariant {
  return {
    id: v.id,
    productId: v.productId,
    sku: v.sku,
    barcode: v.barcode,
    unitPrice: Number(v.unitPrice),
    costPrice: v.costPrice != null ? Number(v.costPrice) : null,
    averageCost: v.averageCost != null ? Number(v.averageCost) : null,
    reorderLevel: v.reorderLevel != null ? Number(v.reorderLevel) : null,
    imageUrl: v.imageUrl,
    position: v.position,
    isActive: v.isActive,
    optionValues: v.optionValues,
  };
}

function toInventory(row: ApiVariantInventory): VariantBranchInventory {
  return {
    branchId: row.branchId,
    branchName: row.branchName,
    quantityOnHand: Number(row.quantityOnHand),
    averageCost: row.averageCost != null ? Number(row.averageCost) : null,
    reorderLevel: row.reorderLevel != null ? Number(row.reorderLevel) : null,
  };
}

function toPurchase(row: ApiVariantPurchase): VariantPurchaseLine {
  return {
    receiptId: row.receiptId,
    receiptNumber: row.receiptNumber,
    receivedAt: row.receivedAt,
    supplierId: row.supplierId,
    supplierName: row.supplierName,
    invoiceReference: row.invoiceReference,
    grnReference: row.grnReference,
    lotNumber: row.lotNumber,
    expiryDate: row.expiryDate,
    quantityReceived: Number(row.quantityReceived),
    unitCost: Number(row.unitCost),
  };
}

// ── Variations (dimensions + options) ────────────────────────────────────────

export interface ReplaceVariationsPayload {
  dimensions: Array<{
    name: string;
    position: number;
    options: Array<{ name: string; position: number }>;
  }>;
}

export async function fetchVariations(
  session: Session,
  productId: string,
): Promise<{ dimensions: ProductVariationDimension[] }> {
  return api.get<{ dimensions: ProductVariationDimension[] }>(
    `/products/${productId}/variations`,
    auth(session),
  );
}

export async function putVariations(
  session: Session,
  productId: string,
  payload: ReplaceVariationsPayload,
): Promise<{ dimensions: ProductVariationDimension[] }> {
  return api.put<{ dimensions: ProductVariationDimension[] }>(
    `/products/${productId}/variations`,
    payload,
    auth(session),
  );
}

// ── Variants ─────────────────────────────────────────────────────────────────

export interface CreateVariantInput {
  sku: string;
  barcode?: string;
  unitPrice: number;
  costPrice?: number;
  reorderLevel?: number;
  openingQuantity?: number;
  imageUrl?: string;
  isActive?: boolean;
  position?: number;
  optionValues: Array<{ dimensionId: string; optionId: string }>;
}

export interface CreateVariantsBatchPayload {
  openingBranchId?: string;
  variants: CreateVariantInput[];
}

export async function fetchVariants(
  session: Session,
  productId: string,
): Promise<ProductVariant[]> {
  const rows = await api.get<ApiVariant[]>(`/products/${productId}/variants`, auth(session));
  return rows.map(toVariant);
}

export async function createVariantsBatch(
  session: Session,
  productId: string,
  payload: CreateVariantsBatchPayload,
): Promise<ProductVariant[]> {
  // `variants:batch` — the colon is a literal segment (Nest routing), so it is
  // NOT URL-encoded. Encoding it would 404.
  const rows = await api.post<ApiVariant[]>(
    `/products/${productId}/variants:batch`,
    payload,
    auth(session),
  );
  return rows.map(toVariant);
}

export type UpdateVariantPatch = Partial<{
  sku: string;
  barcode: string | null;
  unitPrice: number;
  costPrice: number | null;
  reorderLevel: number | null;
  imageUrl: string | null;
  position: number;
  isActive: boolean;
}>;

export async function updateVariant(
  session: Session,
  productId: string,
  variantId: string,
  patch: UpdateVariantPatch,
): Promise<ProductVariant> {
  const row = await api.patch<ApiVariant>(
    `/products/${productId}/variants/${variantId}`,
    patch,
    auth(session),
  );
  return toVariant(row);
}

export async function deleteVariant(
  session: Session,
  productId: string,
  variantId: string,
): Promise<{ id: string }> {
  return api.del<{ id: string }>(`/products/${productId}/variants/${variantId}`, auth(session));
}

export async function uploadVariantImage(
  session: Session,
  productId: string,
  variantId: string,
  file: File,
): Promise<ProductVariant> {
  const form = new FormData();
  form.append('file', file);
  const res = await authorizedFetch(
    `/products/${productId}/variants/${variantId}/image`,
    session,
    { method: 'POST', body: form },
  );
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const message =
      json?.message ??
      (res.status === 413 ? 'Image is too large (max 5MB)' : 'Image upload failed');
    throw new Error(Array.isArray(message) ? message.join(', ') : message);
  }
  return toVariant((json?.data ?? json) as ApiVariant);
}

export async function fetchVariantInventory(
  session: Session,
  productId: string,
  variantId: string,
): Promise<{ branches: VariantBranchInventory[] }> {
  const res = await api.get<{ branches: ApiVariantInventory[] }>(
    `/products/${productId}/variants/${variantId}/inventory`,
    auth(session),
  );
  return { branches: res.branches.map(toInventory) };
}

export async function fetchVariantPurchases(
  session: Session,
  productId: string,
  variantId: string,
): Promise<VariantPurchaseLine[]> {
  const rows = await api.get<ApiVariantPurchase[]>(
    `/products/${productId}/variants/${variantId}/purchases`,
    auth(session),
  );
  return rows.map(toPurchase);
}
