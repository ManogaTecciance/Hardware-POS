import type { SaleReturnStatusCode } from '@hardware-pos/shared';

import { api, authorizedFetch } from './api';
import type { Session } from './auth';
import type { CartItem, DiscountType } from './cart';

import type { Session as LocationSession } from './session-store';

/**
 * The branch/register a sale is recorded against — the session's real
 * location as stated by the server at login. Throws when the user has no
 * branch (misconfigured tenant) so a sale is never invented against one.
 */
export function saleLocation(session: LocationSession): { branchId: string; registerId?: string } {
  if (!session.branchId) {
    throw new Error('No branch is assigned to this account — ask an admin to set one up.');
  }
  return { branchId: session.branchId, registerId: session.registerId ?? undefined };
}

function auth(session: Session): { token: string; tenantId: string } {
  return { token: session.token, tenantId: session.user.tenantId };
}

export type PaymentMethodCode =
  | 'CASH'
  | 'CARD'
  | 'BANK_TRANSFER'
  | 'QR_PAYMENT'
  | 'CHECK'
  | 'STORE_CREDIT'
  | 'OTHER';

export interface SaleItemPayload {
  productId: string;
  /**
   * D99 (1c.7) — the exact variant sold. Mirrors `SaleItemInputDto` on the
   * server: optional, because most sellable things have no variant (loose goods,
   * a service, a single-SKU product).
   *
   * Optional is the risk here, not the convenience: omitting it compiles, and
   * the sale then depletes at product level and freezes no size onto the
   * receipt. No type can catch that — the integration test asserting a non-null
   * stored `productVariantId` is what does.
   */
  productVariantId?: string;
  quantity: number;
  unitPrice?: number;
  discountType?: DiscountType;
  discountValue?: number;
  discountReason?: string;
  approvalToken?: string;
}

/**
 * One cart line as the sale endpoint wants it.
 *
 * Extracted from the payment page (1c.7) for the reason this phase keeps
 * relearning: `productVariantId` is optional on both the payload and the server
 * DTO, so an object literal that forgets it compiles, validates and returns 201
 * while selling at product level. The integration test proves the SERVER handles
 * the id; only this, tested as a function, proves the till ever sends it.
 *
 * The same move as `quickAddVariant` and `resolveScan`: when the rule is the
 * behaviour, make it a pure function rather than an inline literal inside a
 * component the tests cannot reach.
 */
export function toSaleItemPayload(item: CartItem): SaleItemPayload {
  return {
    productId: item.product.id,
    // Undefined, not null: the field is optional on the wire, and a product
    // without variants must send no variant rather than an explicit empty one.
    productVariantId: item.variant?.id,
    quantity: item.quantity,
    discountType: item.discount?.type,
    discountValue: item.discount?.value,
    discountReason: item.discount?.reason,
    approvalToken: item.approvalToken,
  };
}

export interface SalePaymentPayload {
  method: PaymentMethodCode;
  amount: number;
  reference?: string;
}

export interface CompleteSaleDto {
  branchId: string;
  registerId?: string;
  customerId?: string;
  items: SaleItemPayload[];
  payments: SalePaymentPayload[];
  orderDiscountType?: DiscountType;
  orderDiscountValue?: number;
  orderDiscountReason?: string;
  orderApprovalToken?: string;
}

/** What kind of document the customer gets. Mirrors the API's CustomerDocumentKind. */
export type CustomerDocumentKind = 'RECEIPT' | 'INVOICE';

export interface CompletedSale {
  id: string;
  saleNumber: string;
  total: number;
  paidAmount: number;
  balanceAmount: number;
  paymentStatus: string;
  quickbooksDocumentType: string | null;
  syncStatus: string;
}

interface ApiSale {
  id: string;
  saleNumber: string;
  total: string | number;
  paidAmount: string | number;
  balanceAmount: string | number;
  paymentStatus: string;
  quickbooksDocumentType: string | null;
  syncStatus: string;
}

/** Complete a sale via POST /sales/complete. */
export async function completeSale(
  session: Session,
  dto: CompleteSaleDto,
): Promise<CompletedSale> {
  const sale = await api.post<ApiSale>('/sales/complete', dto, auth(session));
  return {
    id: sale.id,
    saleNumber: sale.saleNumber,
    total: Number(sale.total),
    paidAmount: Number(sale.paidAmount),
    balanceAmount: Number(sale.balanceAmount),
    paymentStatus: sale.paymentStatus,
    quickbooksDocumentType: sale.quickbooksDocumentType,
    syncStatus: sale.syncStatus,
  };
}

// ── Sales history (list + detail) ─────────────────────────────────────────────

export type SaleStatusCode = 'DRAFT' | 'COMPLETED' | 'VOIDED' | 'REFUNDED';
export type PaymentStatusCode = 'UNPAID' | 'PARTIAL' | 'PAID' | 'REFUNDED';
export type SyncStatusCode = 'NOT_SYNCED' | 'PENDING' | 'SYNCING' | 'SYNCED' | 'FAILED';

/** A row in the Sales history list (matches the API `SaleListItem`). */
export interface SaleListItem {
  id: string;
  saleNumber: string;
  status: SaleStatusCode;
  createdAt: string;
  completedAt: string | null;
  customerName: string | null;
  cashierName: string | null;
  itemCount: number;
  subtotal: number;
  totalDiscount: number;
  orderDiscountAmount: number;
  taxAmount: number;
  total: number;
  paidAmount: number;
  balanceAmount: number;
  paymentStatus: PaymentStatusCode;
  paymentMethods: PaymentMethodCode[];
  returnStatus: SaleReturnStatusCode;
  returnedAmount: number;
  /** External-integration metadata. `null` when the tenant has no accounting provider. */
  quickbooksDocumentType: string | null;
  syncStatus: SyncStatusCode;
  /**
   * Server-derived customer document kind, always present. Derived from local
   * payment state, never from `quickbooksDocumentType`, and never supplied by this
   * client — the API does not accept one.
   */
  documentKind: CustomerDocumentKind;
}

export interface SalesPage {
  items: SaleListItem[];
  total: number;
  page: number;
  pageSize: number;
}

export interface SalesQuery {
  page?: number;
  pageSize?: number;
  search?: string;
  paymentStatus?: PaymentStatusCode;
  syncStatus?: SyncStatusCode;
  dateFrom?: string;
  dateTo?: string;
}

/** Detailed sale (matches the API `SaleWithRelations`, decimals as strings). */
export interface SaleDetailItem {
  id: string;
  productName: string;
  /**
   * D44 — the variant's display name frozen at sale time; null for a line with
   * no variant. Required-nullable rather than optional so every construction
   * site has to say which it is.
   */
  variantName: string | null;
  /**
   * D101 (3.12) — the tax rate frozen onto this line. Null for a sale written
   * before 3.8; `0` is a real rate (zero-rated or exempt) and means something
   * different.
   */
  taxRatePercent: number | null;
  sku: string | null;
  unitPrice: number;
  quantity: number;
  discountType: DiscountType | null;
  discountValue: number | null;
  discountAmount: number;
  discountReason: string | null;
  lineSubtotal: number;
  lineTotal: number;
}

export interface SaleDetailPayment {
  id: string;
  method: PaymentMethodCode;
  amount: number;
  reference: string | null;
  syncStatus: SyncStatusCode;
}

export interface SaleCustomerContact {
  id: string;
  name: string;
  companyName?: string | null;
  email?: string | null;
  phone?: string | null;
  billingAddress?: string | null;
  taxNumber?: string | null;
}

export interface SaleDetail {
  id: string;
  saleNumber: string;
  status: SaleStatusCode;
  createdAt: string;
  completedAt: string | null;
  customer: SaleCustomerContact | null;
  branch: { id: string; name: string; code: string; address: string | null; phone: string | null } | null;
  register: { id: string; name: string; code: string } | null;
  cashier: { id: string; name: string } | null;
  subtotal: number;
  totalDiscount: number;
  orderDiscountType: DiscountType | null;
  orderDiscountValue: number | null;
  orderDiscountAmount: number;
  orderDiscountReason: string | null;
  taxAmount: number;
  total: number;
  paidAmount: number;
  balanceAmount: number;
  paymentStatus: PaymentStatusCode;
  returnStatus: SaleReturnStatusCode;
  returnedAmount: number;
  quickbooksDocumentType: string | null;
  quickbooksDocumentId: string | null;
  syncStatus: SyncStatusCode;
  syncError: string | null;
  items: SaleDetailItem[];
  payments: SaleDetailPayment[];
}

interface ApiSaleDetail {
  id: string;
  saleNumber: string;
  status: SaleStatusCode;
  createdAt: string;
  completedAt: string | null;
  customer: SaleCustomerContact | null;
  branch: SaleDetail['branch'];
  register: SaleDetail['register'];
  cashier: SaleDetail['cashier'];
  subtotal: string | number;
  totalDiscount: string | number;
  orderDiscountType: DiscountType | null;
  orderDiscountValue: string | number | null;
  orderDiscountAmount: string | number;
  orderDiscountReason: string | null;
  taxAmount: string | number;
  total: string | number;
  paidAmount: string | number;
  balanceAmount: string | number;
  paymentStatus: PaymentStatusCode;
  returnStatus: SaleReturnStatusCode;
  returnedAmount: string | number;
  quickbooksDocumentType: string | null;
  quickbooksDocumentId: string | null;
  syncStatus: SyncStatusCode;
  syncError: string | null;
  items: Array<{
    id: string;
    productName: string;
    /** D44 snapshot; absent on responses predating variants. */
    variantNameSnapshot?: string | null;
    /** D101 snapshot; absent on responses predating per-line tax. */
    taxRatePercent?: string | number | null;
    sku: string | null;
    unitPrice: string | number;
    quantity: string | number;
    discountType: DiscountType | null;
    discountValue: string | number | null;
    discountAmount: string | number;
    discountReason: string | null;
    lineSubtotal: string | number;
    lineTotal: string | number;
  }>;
  payments: Array<{
    id: string;
    method: PaymentMethodCode;
    amount: string | number;
    reference: string | null;
    syncStatus: SyncStatusCode;
  }>;
}

function buildQuery(q: SalesQuery): string {
  const params = new URLSearchParams();
  params.set('page', String(q.page ?? 1));
  params.set('pageSize', String(q.pageSize ?? 25));
  if (q.search) params.set('search', q.search);
  if (q.paymentStatus) params.set('paymentStatus', q.paymentStatus);
  if (q.syncStatus) params.set('syncStatus', q.syncStatus);
  if (q.dateFrom) params.set('dateFrom', q.dateFrom);
  if (q.dateTo) params.set('dateTo', q.dateTo);
  return params.toString();
}

/** Fetch a page of the sales history. */
export async function fetchSales(session: Session, query: SalesQuery = {}): Promise<SalesPage> {
  return api.get<SalesPage>(`/sales?${buildQuery(query)}`, auth(session));
}

export type ReportFormat = 'pdf' | 'xlsx';

/**
 * Download a sales report (PDF or Excel) covering ALL sales that match the
 * given filters — not just the currently visible page. Triggers a browser
 * file download.
 */
export async function downloadSalesReport(
  session: Session,
  query: Omit<SalesQuery, 'page' | 'pageSize'>,
  format: ReportFormat,
): Promise<void> {
  const params = new URLSearchParams();
  params.set('format', format);
  if (query.search) params.set('search', query.search);
  if (query.paymentStatus) params.set('paymentStatus', query.paymentStatus);
  if (query.syncStatus) params.set('syncStatus', query.syncStatus);
  if (query.dateFrom) params.set('dateFrom', query.dateFrom);
  if (query.dateTo) params.set('dateTo', query.dateTo);

  const res = await authorizedFetch(`/sales/report?${params.toString()}`, session);
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string | string[] } | null;
    const message = body?.message ?? `Export failed (HTTP ${res.status})`;
    throw new Error(Array.isArray(message) ? message.join(', ') : message);
  }

  const blob = await res.blob();
  const disposition = res.headers.get('Content-Disposition') ?? '';
  const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? `sales-report.${format}`;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Fetch a single sale with items and payments. */
export async function fetchSale(session: Session, id: string): Promise<SaleDetail> {
  const s = await api.get<ApiSaleDetail>(`/sales/${id}`, auth(session));
  return {
    id: s.id,
    saleNumber: s.saleNumber,
    status: s.status,
    createdAt: s.createdAt,
    completedAt: s.completedAt,
    customer: s.customer,
    branch: s.branch ?? null,
    register: s.register ?? null,
    cashier: s.cashier ?? null,
    subtotal: Number(s.subtotal),
    totalDiscount: Number(s.totalDiscount),
    orderDiscountType: s.orderDiscountType,
    orderDiscountValue: s.orderDiscountValue != null ? Number(s.orderDiscountValue) : null,
    orderDiscountAmount: Number(s.orderDiscountAmount),
    orderDiscountReason: s.orderDiscountReason,
    taxAmount: Number(s.taxAmount),
    total: Number(s.total),
    paidAmount: Number(s.paidAmount),
    balanceAmount: Number(s.balanceAmount),
    paymentStatus: s.paymentStatus,
    returnStatus: s.returnStatus,
    returnedAmount: Number(s.returnedAmount),
    quickbooksDocumentType: s.quickbooksDocumentType,
    quickbooksDocumentId: s.quickbooksDocumentId,
    syncStatus: s.syncStatus,
    syncError: s.syncError,
    items: s.items.map((it) => ({
      id: it.id,
      productName: it.productName,
      // D44/D99 (1c.7) — the SNAPSHOT, never the live variant. Renaming
      // "Medium" to "M" next month must not rewrite last month's sale. The
      // server has always returned this; the client was dropping it, so a
      // returns clerk could not see which size a past sale was for.
      variantName: it.variantNameSnapshot ?? null,
      taxRatePercent: it.taxRatePercent != null ? Number(it.taxRatePercent) : null,
      sku: it.sku,
      unitPrice: Number(it.unitPrice),
      quantity: Number(it.quantity),
      discountType: it.discountType,
      discountValue: it.discountValue != null ? Number(it.discountValue) : null,
      discountAmount: Number(it.discountAmount),
      discountReason: it.discountReason,
      lineSubtotal: Number(it.lineSubtotal),
      lineTotal: Number(it.lineTotal),
    })),
    payments: s.payments.map((p) => ({
      id: p.id,
      method: p.method,
      amount: Number(p.amount),
      reference: p.reference,
      syncStatus: p.syncStatus,
    })),
  };
}

/** Retry the QuickBooks push for a completed sale. */
export async function retrySaleSync(session: Session, id: string): Promise<void> {
  await api.post(`/sales/${id}/retry-sync`, undefined, auth(session));
}

/** Fetch the A4 final-bill / invoice HTML for a completed sale (print or Save-as-PDF). */
export function fetchSaleBillDocument(
  session: Session,
  id: string,
): Promise<{ html: string; format: string }> {
  return api.get(`/documents/sales/${id}`, auth(session));
}
