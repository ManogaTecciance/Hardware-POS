import { QuotationStatusCode, ShareChannelCode } from '@hardware-pos/shared';

export type DiscountTypeCode = 'PERCENTAGE' | 'FIXED';
export type DiscountBasisCode = 'LINE' | 'UNIT';

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
  discountType: DiscountTypeCode | null;
  discountValue: number | null;
  /** Whether a FIXED amount was per unit or for the line. */
  discountBasis: DiscountBasisCode;
  discountAmount: number;
  taxAmount: number;
  lineSubtotal: number;
  lineTotal: number;
  itemNote: string | null;
  availabilityStatus: string | null;
}

export interface QuotationTotalsView {
  subtotal: number;
  productDiscountTotal: number;
  quotationDiscountType: DiscountTypeCode | null;
  quotationDiscountValue: number | null;
  quotationDiscountAmount: number;
  taxAmount: number;
  grandTotal: number;
}

/** Server-recomputed preview used by the create/edit screen's live summary. */
export interface QuotationPreview extends QuotationTotalsView {
  items: QuotationItemView[];
  taxRatePercent: number;
}

export interface QuotationCustomerView {
  id: string;
  name: string;
  companyName: string | null;
  phone: string | null;
  email: string | null;
  billingAddress: string | null;
  taxNumber: string | null;
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

export interface QuotationRevisionDetail extends QuotationRevisionSummary, QuotationTotalsView {
  notes: string | null;
  termsAndConditions: string | null;
  validUntil: string | null;
  items: QuotationItemView[];
}

export interface QuotationDetail extends QuotationTotalsView {
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
  customer: QuotationCustomerView | null;
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

export interface QuotationShareResult {
  channel: ShareChannelCode;
  status: 'SENT' | 'FAILED' | 'PENDING';
  recipient: string | null;
  /** For WhatsApp: the wa.me deep link the browser should open. */
  whatsappUrl?: string;
  /** The public, tokenised share URL for the document. */
  shareUrl?: string;
  message?: string;
  error?: string;
}
