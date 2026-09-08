import type { SaleReturnStatusCode } from '@hardware-pos/shared';

import { api, authorizedFetch } from './api';
import type { Session } from './auth';
import type { DiscountType } from './cart';

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
  quantity: number;
  unitPrice?: number;
  discountType?: DiscountType;
  /** Whether a FIXED amount is per unit or for the line. Absent = the line. */
  discountBasis?: 'LINE' | 'UNIT';
  discountValue?: number;
  discountReason?: string;
  approvalToken?: string;
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
  /** Invoice date as `YYYY-MM-DD`. Omitted = now; the API rejects a future date. */
  saleDate?: string;
  /**
   * When payment is expected, as `YYYY-MM-DD`. Required when the payments do not
   * cover the total; the API rejects it on a fully paid sale.
   */
  paymentDueDate?: string;
  items: SaleItemPayload[];
  payments: SalePaymentPayload[];
  orderDiscountType?: DiscountType;
  orderDiscountValue?: number;
  orderDiscountReason?: string;
  orderApprovalToken?: string;
}

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
  /** When payment is expected. Null on a fully paid sale — the column stays blank. */
  paymentDueDate: string | null;
  /**
   * When the customer's credit account was cleared, covering this invoice.
   * Credit is settled per account, so this — not the invoice's own paidAmount —
   * is what makes a credit sale read as Paid.
   */
  creditSettledAt: string | null;
  /** When a user ticked this invoice off as paid, and who. Moves no money. */
  markedPaidAt: string | null;
  markedPaidByName: string | null;
  /** When the most recent payment was received. Null when none has been. */
  lastPaymentAt: string | null;
  returnStatus: SaleReturnStatusCode;
  returnedAmount: number;
  quickbooksDocumentType: string | null;
  syncStatus: SyncStatusCode;
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
  /** Only this customer's invoices. */
  customerId?: string;
  /** Only sales past their due date that still owe money. */
  overdue?: 'true';
}

/** Detailed sale (matches the API `SaleWithRelations`, decimals as strings). */
export interface SaleDetailItem {
  id: string;
  productName: string;
  sku: string | null;
  unitPrice: number;
  quantity: number;
  discountType: DiscountType | null;
  discountValue: number | null;
  /** Whether a FIXED amount came off each unit or the line as a whole. */
  discountBasis: 'LINE' | 'UNIT';
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
  /** When the payment was received, as an ISO instant. */
  createdAt: string;
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
  /** When payment is expected. Null on a sale that was settled in full. */
  paymentDueDate: string | null;
  /** When the customer's credit account was cleared, covering this invoice. */
  creditSettledAt: string | null;
  /** When a user accounted for this invoice on the customer page, and who. */
  markedPaidAt: string | null;
  markedPaidByName: string | null;
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
  paymentDueDate: string | null;
  creditSettledAt: string | null;
  markedPaidAt: string | null;
  markedPaidBy: { name: string } | null;
  returnStatus: SaleReturnStatusCode;
  returnedAmount: string | number;
  quickbooksDocumentType: string | null;
  quickbooksDocumentId: string | null;
  syncStatus: SyncStatusCode;
  syncError: string | null;
  items: Array<{
    id: string;
    productName: string;
    sku: string | null;
    unitPrice: string | number;
    quantity: string | number;
    discountType: DiscountType | null;
    discountValue: string | number | null;
    discountBasis: 'LINE' | 'UNIT';
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
    createdAt: string;
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
  if (q.overdue) params.set('overdue', q.overdue);
  if (q.customerId) params.set('customerId', q.customerId);
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
  if (query.overdue) params.set('overdue', query.overdue);

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
    paymentDueDate: s.paymentDueDate ?? null,
    creditSettledAt: s.creditSettledAt ?? null,
    markedPaidAt: s.markedPaidAt ?? null,
    markedPaidByName: s.markedPaidBy?.name ?? null,
    returnStatus: s.returnStatus,
    returnedAmount: Number(s.returnedAmount),
    quickbooksDocumentType: s.quickbooksDocumentType,
    quickbooksDocumentId: s.quickbooksDocumentId,
    syncStatus: s.syncStatus,
    syncError: s.syncError,
    items: s.items.map((it) => ({
      id: it.id,
      productName: it.productName,
      sku: it.sku,
      unitPrice: Number(it.unitPrice),
      quantity: Number(it.quantity),
      discountType: it.discountType,
      discountValue: it.discountValue != null ? Number(it.discountValue) : null,
      discountBasis: it.discountBasis ?? 'LINE',
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
      createdAt: p.createdAt,
    })),
  };
}

/**
 * Tick a credit invoice off as paid, or clear the tick.
 *
 * A bookkeeping note: it records who and when, and moves no money. The API
 * refuses the last uncovered invoice on an account while the account still owes.
 */
export async function setSaleMarkedPaid(
  session: Session,
  id: string,
  marked: boolean,
): Promise<void> {
  await api.post(`/sales/${id}/marked-paid`, { marked }, auth(session));
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
