/**
 * Client for Purchase Receipts / Receive Stock endpoints (D44).
 *
 * The wizard itself does NOT create receipts here — its opening-stock path
 * runs inside the `variants:batch` transaction so weighted-average is seeded
 * on one code path. This module exists for the Receive Stock dialog and the
 * variant purchase-history view; it's kept next to `variants-api.ts` so the
 * whole product surface pulls from one directory.
 */

import { api } from '../api';
import type { Session } from '../auth';

export interface InventoryReceiptLine {
  id: string;
  productId: string;
  productVariantId: string | null;
  quantityReceived: number;
  unitCost: number;
  lotNumber: string | null;
  expiryDate: string | null;
}

export interface InventoryReceipt {
  id: string;
  receiptNumber: string;
  branchId: string;
  branchName: string;
  supplierId: string | null;
  supplierName: string | null;
  receivedAt: string;
  invoiceReference: string | null;
  grnReference: string | null;
  notes: string | null;
  createdByUserId: string;
  createdAt: string;
  lines: InventoryReceiptLine[];
}

export interface CreateReceiptPayload {
  branchId: string;
  supplierId?: string;
  receivedAt?: string;
  invoiceReference?: string;
  grnReference?: string;
  notes?: string;
  /**
   * Idempotency key echoed back to prevent duplicate posts when the operator
   * double-clicks Save; the server upserts by `(tenantId, idempotencyKey)`.
   */
  idempotencyKey?: string;
  lines: Array<{
    productId: string;
    productVariantId?: string;
    quantityReceived: number;
    unitCost: number;
    lotNumber?: string;
    expiryDate?: string;
  }>;
}

export interface ReceiptQuery {
  branchId?: string;
  supplierId?: string;
  productId?: string;
  productVariantId?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

// ── Wire shapes (decimals arrive as strings; Date instances as ISO strings) ──

interface ApiReceiptLine {
  id: string;
  productId: string;
  productVariantId: string | null;
  quantityReceived: string | number;
  unitCost: string | number;
  lotNumber: string | null;
  expiryDate: string | null;
}

interface ApiReceipt {
  id: string;
  receiptNumber: string;
  branchId: string;
  branchName: string | null;
  supplierId: string | null;
  supplierName: string | null;
  receivedAt: string;
  invoiceReference: string | null;
  grnReference: string | null;
  notes: string | null;
  createdByUserId: string;
  createdAt: string;
  lines: ApiReceiptLine[];
}

function auth(session: Session): { token: string; tenantId: string } {
  return { token: session.token, tenantId: session.user.tenantId };
}

function toLine(l: ApiReceiptLine): InventoryReceiptLine {
  return {
    id: l.id,
    productId: l.productId,
    productVariantId: l.productVariantId,
    quantityReceived: Number(l.quantityReceived),
    unitCost: Number(l.unitCost),
    lotNumber: l.lotNumber,
    expiryDate: l.expiryDate,
  };
}

function toReceipt(r: ApiReceipt): InventoryReceipt {
  return {
    id: r.id,
    receiptNumber: r.receiptNumber,
    branchId: r.branchId,
    // `branchName` can be null in some server responses (defensive JOIN); the
    // UI treats missing as empty string rather than showing "null".
    branchName: r.branchName ?? '',
    supplierId: r.supplierId,
    supplierName: r.supplierName,
    receivedAt: r.receivedAt,
    invoiceReference: r.invoiceReference,
    grnReference: r.grnReference,
    notes: r.notes,
    createdByUserId: r.createdByUserId,
    createdAt: r.createdAt,
    lines: r.lines.map(toLine),
  };
}

function buildQuery(q: ReceiptQuery): string {
  const params = new URLSearchParams();
  if (q.branchId) params.set('branchId', q.branchId);
  if (q.supplierId) params.set('supplierId', q.supplierId);
  if (q.productId) params.set('productId', q.productId);
  if (q.productVariantId) params.set('productVariantId', q.productVariantId);
  if (q.from) params.set('from', q.from);
  if (q.to) params.set('to', q.to);
  if (q.limit != null) params.set('limit', String(q.limit));
  if (q.offset != null) params.set('offset', String(q.offset));
  return params.toString();
}

export async function createReceipt(
  session: Session,
  payload: CreateReceiptPayload,
): Promise<InventoryReceipt> {
  return toReceipt(await api.post<ApiReceipt>('/inventory-receipts', payload, auth(session)));
}

export async function fetchReceipts(
  session: Session,
  query: ReceiptQuery = {},
): Promise<{ items: InventoryReceipt[]; total: number }> {
  const qs = buildQuery(query);
  const res = await api.get<{ items: ApiReceipt[]; total: number }>(
    `/inventory-receipts${qs ? `?${qs}` : ''}`,
    auth(session),
  );
  return { items: res.items.map(toReceipt), total: res.total };
}

export async function fetchReceipt(session: Session, id: string): Promise<InventoryReceipt> {
  return toReceipt(await api.get<ApiReceipt>(`/inventory-receipts/${id}`, auth(session)));
}
