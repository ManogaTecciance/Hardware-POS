import {
  ItemCondition,
  PaymentMethod,
  QuickBooksReturnDocumentType,
  RefundStatus,
  ReturnReason,
  ReturnStatus,
  StockDisposition,
  SyncStatus,
  UserRole,
} from '@hardware-pos/database';

import { CustomerReturnDocumentKind } from './customer-return-document';

/** Signed inside the short-lived return-approval token. */
export interface ReturnApprovalTokenPayload {
  typ: 'return-approval';
  tenantId: string;
  originalSaleId: string;
  refundTotal: number;
  approvedByUserId: string;
  approverRole: UserRole;
}

/** Response of POST /returns/approve. */
export interface ReturnApprovalResult {
  approved: boolean;
  approvedByUserId: string | null;
  approvalToken: string | null;
  expiresAt: string | null;
  reason?: string;
}

/** A returnable line as shown on the sale-detail / return-creation screen. */
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

/** Whether a sale can be returned against, and why / why not. */
export interface ReturnEligibility {
  saleId: string;
  saleNumber: string;
  eligible: boolean;
  reasons: string[];
  returnPeriodDays: number;
  withinReturnWindow: boolean;
  daysSinceSale: number | null;
  alreadyFullyReturned: boolean;
  originalPaymentMethods: PaymentMethod[];
  isCreditCustomer: boolean;
}

/** One computed line in a refund preview. */
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
  returnReason: ReturnReason;
  itemCondition: ItemCondition;
  stockDisposition: StockDisposition;
}

/** Server-computed refund preview + approval requirement (never trust the client). */
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
  suggestedRefundMethod: PaymentMethod | null;
  allowedRefundMethods: PaymentMethod[];
  /**
   * The external accounting document, or `null` for a tenant with no accounting
   * provider. Integration metadata — never the authority for what the customer is
   * handed; that is {@link documentKind}.
   */
  quickbooksDocumentType: QuickBooksReturnDocumentType | null;
  /** The customer-facing document, decided from local financial facts. */
  documentKind: CustomerReturnDocumentKind;
}

/** A flattened row for the Returns list (money as numbers). */
export interface ReturnListItem {
  id: string;
  returnNumber: string;
  originalSaleId: string;
  originalSaleNumber: string;
  createdAt: Date;
  completedAt: Date | null;
  customerName: string | null;
  cashierName: string | null;
  itemCount: number;
  refundTotal: number;
  refundMethod: PaymentMethod | null;
  status: ReturnStatus;
  refundStatus: RefundStatus;
  syncStatus: SyncStatus;
  /**
   * The external accounting document, or `null` for a tenant with no accounting
   * provider. Exposed so the list can tell "no external accounting" apart from
   * "not pushed yet" and suppress the sync column for the former, instead of
   * showing every restaurant tenant a QuickBooks status they have no use for.
   */
  quickbooksDocumentType: QuickBooksReturnDocumentType | null;
  /** The customer-facing document, decided from local financial facts. */
  documentKind: CustomerReturnDocumentKind;
}

export interface ReturnsListFilter {
  status?: ReturnStatus;
  refundStatus?: RefundStatus;
  syncStatus?: SyncStatus;
  refundMethod?: PaymentMethod;
  search?: string;
  originalSaleId?: string;
  dateFrom?: Date;
  dateTo?: Date;
}

/** A fully-computed return line ready to persist. */
export interface PersistReturnItem {
  originalSaleItemId: string;
  productId: string;
  productNameSnapshot: string;
  skuSnapshot: string | null;
  imageUrlSnapshot: string | null;
  originalUnitPrice: number;
  purchasedQuantity: number;
  previouslyReturnedQuantity: number;
  returnQuantity: number;
  returnReason: ReturnReason;
  itemCondition: ItemCondition;
  stockDisposition: StockDisposition;
  note: string | null;
  originalLineSubtotal: number;
  productDiscountAdjustment: number;
  orderDiscountAdjustment: number;
  taxAdjustment: number;
  refundableAmount: number;
}

/** Everything the repository needs to persist a completed return atomically. */
export interface PersistReturnInput {
  tenantId: string;
  branchId: string;
  registerId: string | null;
  originalSaleId: string;
  customerId: string | null;
  createdByUserId: string;
  approvedByUserId: string | null;
  approvalToken: string | null;
  idempotencyKey: string | null;
  notes: string | null;
  subtotal: number;
  productDiscountAdjustment: number;
  orderDiscountAdjustment: number;
  taxAdjustment: number;
  refundTotal: number;
  refundMethod: PaymentMethod;
  refundReference: string | null;
  refundMetadata: Record<string, unknown> | null;
  /** `null` when the tenant's accounting provider files nothing externally. */
  quickbooksDocumentType: QuickBooksReturnDocumentType | null;
  /**
   * Persisted verbatim rather than hardcoded to `PENDING`. A return with no
   * external document has nothing pending, and leaving it `PENDING` would show a
   * QuickBooks push that is never going to happen.
   */
  syncStatus: SyncStatus;
  items: PersistReturnItem[];
}
