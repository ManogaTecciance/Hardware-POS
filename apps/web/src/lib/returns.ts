import type {
  ItemConditionCode,
  RefundStatusCode,
  ReturnReasonCode,
  ReturnStatusCode,
  StockDispositionCode,
} from '@hardware-pos/shared';

import { api } from './api';
import type { Session } from './auth';
import type { PaymentMethodCode, SyncStatusCode } from './sales';

function auth(session: Session): { token: string; tenantId: string } {
  return { token: session.token, tenantId: session.user.tenantId };
}

export type QboReturnDocType = 'REFUND_RECEIPT' | 'CREDIT_MEMO';

/**
 * The customer-facing return document, decided from LOCAL financial facts by the
 * server (Slice 6B). Independent of {@link QboReturnDocType}, which is external
 * accounting metadata and is `null` for a tenant with no accounting provider.
 */
export type CustomerReturnDocumentKind = 'REFUND_RECEIPT' | 'CREDIT_NOTE';

// ── sale-scoped reads ────────────────────────────────────────────────────────

export interface ReturnEligibility {
  saleId: string;
  saleNumber: string;
  eligible: boolean;
  reasons: string[];
  returnPeriodDays: number;
  withinReturnWindow: boolean;
  daysSinceSale: number | null;
  alreadyFullyReturned: boolean;
  originalPaymentMethods: PaymentMethodCode[];
  isCreditCustomer: boolean;
}

export interface ReturnableItem {
  saleItemId: string;
  productId: string;
  productName: string;
  sku: string | null;
  imageUrl: string | null;
  unitPrice: number;
  purchasedQuantity: number;
  previouslyReturnedQuantity: number;
  availableReturnQuantity: number;
  productDiscount: number;
  lineTotal: number;
}

export function fetchReturnEligibility(session: Session, saleId: string): Promise<ReturnEligibility> {
  return api.get<ReturnEligibility>(`/sales/${saleId}/return-eligibility`, auth(session));
}

export function fetchReturnableItems(session: Session, saleId: string): Promise<ReturnableItem[]> {
  return api.get<ReturnableItem[]>(`/sales/${saleId}/returnable-items`, auth(session));
}

// ── preview ──────────────────────────────────────────────────────────────────

export interface ReturnItemInput {
  saleItemId: string;
  returnQuantity: number;
  returnReason: ReturnReasonCode;
  itemCondition: ItemConditionCode;
  stockDisposition: StockDispositionCode;
  note?: string;
}

export interface ReturnPreviewItem {
  saleItemId: string;
  productId: string;
  productName: string;
  sku: string | null;
  returnQuantity: number;
  originalUnitPrice: number;
  originalLineSubtotal: number;
  productDiscountAdjustment: number;
  orderDiscountAdjustment: number;
  taxAdjustment: number;
  refundableAmount: number;
  returnReason: ReturnReasonCode;
  itemCondition: ItemConditionCode;
  stockDisposition: StockDispositionCode;
}

export interface ReturnPreview {
  originalSaleId: string;
  saleNumber: string;
  items: ReturnPreviewItem[];
  subtotal: number;
  productDiscountAdjustment: number;
  orderDiscountAdjustment: number;
  taxAdjustment: number;
  refundTotal: number;
  isFullReturn: boolean;
  requiresApproval: boolean;
  approvalReasons: string[];
  suggestedRefundMethod: PaymentMethodCode | null;
  allowedRefundMethods: PaymentMethodCode[];
  quickbooksDocumentType: QboReturnDocType | null;
  documentKind: CustomerReturnDocumentKind;
}

export function previewReturn(
  session: Session,
  dto: { originalSaleId: string; items: ReturnItemInput[]; refundMethod?: PaymentMethodCode },
): Promise<ReturnPreview> {
  return api.post<ReturnPreview>('/returns/preview', dto, auth(session));
}

// ── approval ─────────────────────────────────────────────────────────────────

export interface ReturnApprovalResult {
  approved: boolean;
  approvedByUserId: string | null;
  approvalToken: string | null;
  expiresAt: string | null;
  reason?: string;
}

export function approveReturn(
  session: Session,
  dto: { managerPin: string; originalSaleId: string; refundTotal: number; reason?: string },
): Promise<ReturnApprovalResult> {
  return api.post<ReturnApprovalResult>('/returns/approve', dto, auth(session));
}

// ── create ───────────────────────────────────────────────────────────────────

export interface CreateReturnDto {
  originalSaleId: string;
  items: ReturnItemInput[];
  refundMethod: PaymentMethodCode;
  refundReference?: string;
  refundMetadata?: Record<string, unknown>;
  approvalToken?: string;
  notes?: string;
  idempotencyKey?: string;
}

export async function createReturn(
  session: Session,
  dto: CreateReturnDto,
): Promise<ReturnDetail> {
  const opts = { ...auth(session) };
  const raw = await api.post<ApiReturnDetail>('/returns', dto, opts);
  return normalizeReturnDetail(raw);
}

// ── list / detail ────────────────────────────────────────────────────────────

export interface ReturnListItem {
  id: string;
  returnNumber: string;
  originalSaleId: string;
  originalSaleNumber: string;
  createdAt: string;
  completedAt: string | null;
  customerName: string | null;
  cashierName: string | null;
  itemCount: number;
  refundTotal: number;
  refundMethod: PaymentMethodCode | null;
  status: ReturnStatusCode;
  refundStatus: RefundStatusCode;
  syncStatus: SyncStatusCode;
  /** `null` when the tenant has no accounting provider — no sync column applies. */
  quickbooksDocumentType: QboReturnDocType | null;
  documentKind: CustomerReturnDocumentKind;
}

export interface ReturnsPage {
  items: ReturnListItem[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ReturnsQuery {
  page?: number;
  pageSize?: number;
  search?: string;
  status?: ReturnStatusCode;
  refundStatus?: RefundStatusCode;
  syncStatus?: SyncStatusCode;
  refundMethod?: PaymentMethodCode;
  originalSaleId?: string;
  dateFrom?: string;
  dateTo?: string;
}

export interface ReturnDetailItem {
  id: string;
  productNameSnapshot: string;
  skuSnapshot: string | null;
  imageUrlSnapshot: string | null;
  originalUnitPrice: number;
  purchasedQuantity: number;
  previouslyReturnedQuantity: number;
  returnQuantity: number;
  returnReason: ReturnReasonCode;
  itemCondition: ItemConditionCode;
  stockDisposition: StockDispositionCode;
  note: string | null;
  originalLineSubtotal: number;
  productDiscountAdjustment: number;
  orderDiscountAdjustment: number;
  taxAdjustment: number;
  refundableAmount: number;
}

export interface RefundPaymentDetail {
  id: string;
  method: PaymentMethodCode;
  amount: number;
  reference: string | null;
  quickbooksPaymentId: string | null;
  syncStatus: SyncStatusCode;
}

export interface ReturnDetail {
  id: string;
  returnNumber: string;
  status: ReturnStatusCode;
  createdAt: string;
  completedAt: string | null;
  originalSale: { id: string; saleNumber: string; total: number; returnedAmount: number };
  customer: { id: string; name: string; phone: string | null } | null;
  createdBy: { id: string; name: string } | null;
  approvedBy: { id: string; name: string } | null;
  branch: { id: string; name: string } | null;
  register: { id: string; name: string } | null;
  subtotal: number;
  productDiscountAdjustment: number;
  orderDiscountAdjustment: number;
  taxAdjustment: number;
  refundTotal: number;
  refundMethod: PaymentMethodCode | null;
  refundReference: string | null;
  refundStatus: RefundStatusCode;
  quickbooksDocumentType: QboReturnDocType | null;
  quickbooksDocumentId: string | null;
  syncStatus: SyncStatusCode;
  syncError: string | null;
  notes: string | null;
  items: ReturnDetailItem[];
  refundPayments: RefundPaymentDetail[];
}

type NumLike = string | number;
interface ApiReturnDetail {
  id: string;
  returnNumber: string;
  status: ReturnStatusCode;
  createdAt: string;
  completedAt: string | null;
  originalSale: { id: string; saleNumber: string; total: NumLike; returnedAmount: NumLike };
  customer: { id: string; name: string; phone: string | null } | null;
  createdBy: { id: string; name: string } | null;
  approvedBy: { id: string; name: string } | null;
  branch: { id: string; name: string } | null;
  register: { id: string; name: string } | null;
  subtotal: NumLike;
  productDiscountAdjustment: NumLike;
  orderDiscountAdjustment: NumLike;
  taxAdjustment: NumLike;
  refundTotal: NumLike;
  refundMethod: PaymentMethodCode | null;
  refundReference: string | null;
  refundStatus: RefundStatusCode;
  quickbooksDocumentType: QboReturnDocType | null;
  quickbooksDocumentId: string | null;
  syncStatus: SyncStatusCode;
  syncError: string | null;
  notes: string | null;
  items: Array<Record<string, NumLike | string | null>>;
  refundPayments: Array<Record<string, NumLike | string | null>>;
}

function num(v: NumLike | null | undefined): number {
  return v == null ? 0 : Number(v);
}

function normalizeReturnDetail(r: ApiReturnDetail): ReturnDetail {
  return {
    id: r.id,
    returnNumber: r.returnNumber,
    status: r.status,
    createdAt: r.createdAt,
    completedAt: r.completedAt,
    originalSale: {
      id: r.originalSale.id,
      saleNumber: r.originalSale.saleNumber,
      total: num(r.originalSale.total),
      returnedAmount: num(r.originalSale.returnedAmount),
    },
    customer: r.customer,
    createdBy: r.createdBy,
    approvedBy: r.approvedBy,
    branch: r.branch,
    register: r.register,
    subtotal: num(r.subtotal),
    productDiscountAdjustment: num(r.productDiscountAdjustment),
    orderDiscountAdjustment: num(r.orderDiscountAdjustment),
    taxAdjustment: num(r.taxAdjustment),
    refundTotal: num(r.refundTotal),
    refundMethod: r.refundMethod,
    refundReference: r.refundReference,
    refundStatus: r.refundStatus,
    quickbooksDocumentType: r.quickbooksDocumentType,
    quickbooksDocumentId: r.quickbooksDocumentId,
    syncStatus: r.syncStatus,
    syncError: r.syncError,
    notes: r.notes,
    items: r.items.map((it) => ({
      id: String(it.id),
      productNameSnapshot: String(it.productNameSnapshot ?? ''),
      skuSnapshot: (it.skuSnapshot as string | null) ?? null,
      imageUrlSnapshot: (it.imageUrlSnapshot as string | null) ?? null,
      originalUnitPrice: num(it.originalUnitPrice as NumLike),
      purchasedQuantity: num(it.purchasedQuantity as NumLike),
      previouslyReturnedQuantity: num(it.previouslyReturnedQuantity as NumLike),
      returnQuantity: num(it.returnQuantity as NumLike),
      returnReason: it.returnReason as ReturnReasonCode,
      itemCondition: it.itemCondition as ItemConditionCode,
      stockDisposition: it.stockDisposition as StockDispositionCode,
      note: (it.note as string | null) ?? null,
      originalLineSubtotal: num(it.originalLineSubtotal as NumLike),
      productDiscountAdjustment: num(it.productDiscountAdjustment as NumLike),
      orderDiscountAdjustment: num(it.orderDiscountAdjustment as NumLike),
      taxAdjustment: num(it.taxAdjustment as NumLike),
      refundableAmount: num(it.refundableAmount as NumLike),
    })),
    refundPayments: r.refundPayments.map((p) => ({
      id: String(p.id),
      method: p.method as PaymentMethodCode,
      amount: num(p.amount as NumLike),
      reference: (p.reference as string | null) ?? null,
      quickbooksPaymentId: (p.quickbooksPaymentId as string | null) ?? null,
      syncStatus: p.syncStatus as SyncStatusCode,
    })),
  };
}

function buildQuery(q: ReturnsQuery): string {
  const params = new URLSearchParams();
  params.set('page', String(q.page ?? 1));
  params.set('pageSize', String(q.pageSize ?? 25));
  if (q.search) params.set('search', q.search);
  if (q.status) params.set('status', q.status);
  if (q.refundStatus) params.set('refundStatus', q.refundStatus);
  if (q.syncStatus) params.set('syncStatus', q.syncStatus);
  if (q.refundMethod) params.set('refundMethod', q.refundMethod);
  if (q.originalSaleId) params.set('originalSaleId', q.originalSaleId);
  if (q.dateFrom) params.set('dateFrom', q.dateFrom);
  if (q.dateTo) params.set('dateTo', q.dateTo);
  return params.toString();
}

export function fetchReturns(session: Session, query: ReturnsQuery = {}): Promise<ReturnsPage> {
  return api.get<ReturnsPage>(`/returns?${buildQuery(query)}`, auth(session));
}

export async function fetchReturn(session: Session, id: string): Promise<ReturnDetail> {
  const raw = await api.get<ApiReturnDetail>(`/returns/${id}`, auth(session));
  return normalizeReturnDetail(raw);
}

/** Prior returns for a sale (Sale-detail "Returns" section). */
export async function fetchSaleReturns(session: Session, saleId: string): Promise<ReturnDetail[]> {
  const raw = await api.get<ApiReturnDetail[]>(`/sales/${saleId}/returns`, auth(session));
  return raw.map(normalizeReturnDetail);
}

export function generateReturnReceipt(
  session: Session,
  id: string,
): Promise<{ printJobId: string; html: string }> {
  return api.post<{ printJobId: string; html: string }>(`/returns/${id}/receipt`, undefined, auth(session));
}

export function retryReturnSync(session: Session, id: string): Promise<{ id: string; syncStatus: string }> {
  return api.post<{ id: string; syncStatus: string }>(`/returns/${id}/retry-sync`, undefined, auth(session));
}

/** A4 return / refund note HTML (print or Save-as-PDF). */
export function fetchReturnDocument(
  session: Session,
  id: string,
): Promise<{ html: string; format: string }> {
  return api.get<{ html: string; format: string }>(`/documents/returns/${id}`, auth(session));
}
