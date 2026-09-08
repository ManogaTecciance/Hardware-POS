import type { Paginated, QuotationStatusCode } from '@hardware-pos/shared';

import { api } from './api';
import type { Session } from './auth';

export type DiscountType = 'PERCENTAGE' | 'FIXED';
/** What a FIXED amount is measured against. Absent reads as the line as a whole. */
export type DiscountBasis = 'LINE' | 'UNIT';

function auth(session: Session): { token: string; tenantId: string } {
  return { token: session.token, tenantId: session.user.tenantId };
}

// ── Wire shapes (the API already returns numbers, not Decimal strings) ───────

export interface QuotationItemView {
  id: string | null;
  productId: string | null;
  productName: string;
  sku: string | null;
  imageUrl: string | null;
  description: string | null;
  category: string | null;
  subcategory: string | null;
  quantity: number;
  unitType: string | null;
  unitPrice: number;
  discountType: DiscountType | null;
  discountValue: number | null;
  discountBasis: DiscountBasis;
  discountAmount: number;
  taxAmount: number;
  lineSubtotal: number;
  lineTotal: number;
  itemNote: string | null;
  availabilityStatus: string | null;
}

export interface QuotationTotals {
  subtotal: number;
  productDiscountTotal: number;
  quotationDiscountType: DiscountType | null;
  quotationDiscountValue: number | null;
  quotationDiscountAmount: number;
  taxAmount: number;
  grandTotal: number;
}

export interface QuotationPreview extends QuotationTotals {
  items: QuotationItemView[];
  taxRatePercent: number;
}

export interface QuotationCustomer {
  id: string;
  name: string;
  companyName: string | null;
  phone: string | null;
  email: string | null;
  billingAddress: string | null;
  taxNumber: string | null;
}

export interface QuotationDetail extends QuotationTotals {
  id: string;
  quotationNumber: string;
  revisionLabel: string;
  currentRevisionNumber: number;
  status: QuotationStatusCode;
  issueDate: string;
  validUntil: string | null;
  isExpired: boolean;
  notes: string | null;
  termsAndConditions: string | null;
  customer: QuotationCustomer | null;
  createdByName: string | null;
  branchName: string | null;
  branchAddress: string | null;
  branchPhone: string | null;
  convertedSaleId: string | null;
  convertedSaleNumber: string | null;
  shareToken: string | null;
  items: QuotationItemView[];
  createdAt: string;
  updatedAt: string;
}

export interface QuotationListItem {
  id: string;
  quotationNumber: string;
  revisionLabel: string;
  currentRevisionNumber: number;
  status: QuotationStatusCode;
  issueDate: string;
  validUntil: string | null;
  isExpired: boolean;
  customerId: string | null;
  customerName: string | null;
  customerPhone: string | null;
  itemCount: number;
  grandTotal: number;
  createdByName: string | null;
  updatedAt: string;
  convertedSaleId: string | null;
}

export interface QuotationRevisionSummary {
  id: string;
  revisionNumber: number;
  changeReason: string | null;
  previousGrandTotal: number | null;
  grandTotal: number;
  itemCount: number;
  changedByName: string | null;
  createdAt: string;
}

export interface QuotationShareResult {
  channel: 'WHATSAPP' | 'EMAIL' | 'DOWNLOAD' | 'PRINT';
  status: 'SENT' | 'FAILED' | 'PENDING';
  recipient: string | null;
  whatsappUrl?: string;
  shareUrl?: string;
  message?: string;
  error?: string;
}

// ── Request payloads ─────────────────────────────────────────────────────────

export interface QuotationItemInput {
  productId?: string | null;
  productName?: string;
  sku?: string;
  description?: string;
  quantity: number;
  unitType?: string;
  unitPrice?: number;
  discountType?: DiscountType;
  discountValue?: number;
  /** Whether a FIXED amount is per unit or for the line. Absent = the line. */
  discountBasis?: DiscountBasis;
  itemNote?: string;
}

export interface CreateQuotationBody {
  customerId?: string | null;
  branchId?: string;
  validUntil?: string;
  notes?: string;
  termsAndConditions?: string;
  quotationDiscountType?: DiscountType;
  quotationDiscountValue?: number;
  items: QuotationItemInput[];
  status?: 'DRAFT' | 'SENT';
}

export interface UpdateQuotationBody {
  customerId?: string | null;
  quotationDiscountType?: DiscountType;
  quotationDiscountValue?: number;
  clearQuotationDiscount?: boolean;
  validUntil?: string;
  notes?: string;
  termsAndConditions?: string;
  items?: QuotationItemInput[];
}

export interface CreateRevisionBody extends UpdateQuotationBody {
  changeReason?: string;
  items: QuotationItemInput[];
}

export interface QuotationsQuery {
  page?: number;
  pageSize?: number;
  search?: string;
  status?: QuotationStatusCode;
  customerId?: string;
  dateFrom?: string;
  dateTo?: string;
  validity?: 'valid' | 'expired';
  sortBy?: 'createdAt' | 'issueDate' | 'validUntil' | 'grandTotal' | 'quotationNumber';
  sortDir?: 'asc' | 'desc';
}

export interface ConvertBody {
  branchId?: string;
  registerId?: string;
  payments?: { method: string; amount: number; reference?: string }[];
  override?: boolean;
}

function buildQuery(q: QuotationsQuery): string {
  const p = new URLSearchParams();
  p.set('page', String(q.page ?? 1));
  p.set('pageSize', String(q.pageSize ?? 25));
  if (q.search) p.set('search', q.search);
  if (q.status) p.set('status', q.status);
  if (q.customerId) p.set('customerId', q.customerId);
  if (q.dateFrom) p.set('dateFrom', q.dateFrom);
  if (q.dateTo) p.set('dateTo', q.dateTo);
  if (q.validity) p.set('validity', q.validity);
  if (q.sortBy) p.set('sortBy', q.sortBy);
  if (q.sortDir) p.set('sortDir', q.sortDir);
  return p.toString();
}

// ── Client functions ─────────────────────────────────────────────────────────

export function fetchQuotations(
  session: Session,
  query: QuotationsQuery = {},
): Promise<Paginated<QuotationListItem>> {
  return api.get(`/quotations?${buildQuery(query)}`, auth(session));
}

export function fetchQuotation(session: Session, id: string): Promise<QuotationDetail> {
  return api.get(`/quotations/${id}`, auth(session));
}

export function previewQuotation(
  session: Session,
  body: CreateQuotationBody,
): Promise<QuotationPreview> {
  return api.post('/quotations/preview', body, auth(session));
}

export function createQuotation(
  session: Session,
  body: CreateQuotationBody,
): Promise<QuotationDetail> {
  return api.post('/quotations', body, auth(session));
}

export function updateQuotation(
  session: Session,
  id: string,
  body: UpdateQuotationBody,
): Promise<QuotationDetail> {
  return api.patch(`/quotations/${id}`, body, auth(session));
}

export function createRevision(
  session: Session,
  id: string,
  body: CreateRevisionBody,
): Promise<QuotationDetail> {
  return api.post(`/quotations/${id}/revisions`, body, auth(session));
}

export function fetchRevisions(
  session: Session,
  id: string,
): Promise<QuotationRevisionSummary[]> {
  return api.get(`/quotations/${id}/revisions`, auth(session));
}

export function duplicateQuotation(session: Session, id: string): Promise<QuotationDetail> {
  return api.post(`/quotations/${id}/duplicate`, undefined, auth(session));
}

export function markQuotationSent(session: Session, id: string): Promise<QuotationDetail> {
  return api.post(`/quotations/${id}/mark-sent`, undefined, auth(session));
}

export function cancelQuotation(session: Session, id: string): Promise<QuotationDetail> {
  return api.post(`/quotations/${id}/cancel`, undefined, auth(session));
}

export function convertQuotationToSale(
  session: Session,
  id: string,
  body: ConvertBody,
): Promise<{ saleId: string; saleNumber: string; quotationId: string }> {
  return api.post(`/quotations/${id}/convert-to-sale`, body, auth(session));
}

export function fetchQuotationDocument(
  session: Session,
  id: string,
): Promise<{ html: string; pdfAvailable: boolean }> {
  return api.get(`/quotations/${id}/pdf`, auth(session));
}

export function shareQuotationWhatsapp(
  session: Session,
  id: string,
  phone?: string,
): Promise<QuotationShareResult> {
  return api.post(`/quotations/${id}/share/whatsapp`, { phone }, auth(session));
}

export function shareQuotationEmail(
  session: Session,
  id: string,
  body: { to?: string; cc?: string[]; subject?: string; message?: string },
): Promise<QuotationShareResult> {
  return api.post(`/quotations/${id}/share/email`, body, auth(session));
}

/** Open printable A4 HTML in a popup for print / Save-as-PDF. */
export function openPrintWindow(html: string): void {
  const win = window.open('', '_blank', 'width=880,height=1000');
  if (!win) return;
  win.document.open();
  win.document.write(html);
  win.document.close();
  win.focus();
}
