import {
  DiscountType,
  PaymentMethod,
  PaymentStatus,
  QuickBooksDocumentType,
  SaleReturnStatus,
  SaleStatus,
  SyncStatus,
} from '@hardware-pos/database';

import { CustomerDocumentKind } from './customer-document';

/** A row in the sales history list — enriched with names + item count, money as numbers. */
export interface SaleListItem {
  id: string;
  saleNumber: string;
  status: SaleStatus;
  createdAt: Date;
  completedAt: Date | null;
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
  paymentStatus: PaymentStatus;
  paymentMethods: PaymentMethod[];
  returnStatus: SaleReturnStatus;
  returnedAmount: number;
  /** External-integration metadata. `null` when the tenant has no accounting provider. */
  quickbooksDocumentType: QuickBooksDocumentType | null;
  syncStatus: SyncStatus;
  /**
   * What kind of document the customer gets, derived from local payment state and
   * always present — including for a tenant with no accounting provider.
   */
  documentKind: CustomerDocumentKind;
}

/** Filters accepted by the sales history list. */
export interface SalesListFilter {
  syncStatus?: SyncStatus;
  paymentStatus?: PaymentStatus;
  search?: string;
  dateFrom?: Date;
  dateTo?: Date;
}

/** Normalized cart line coming into the compute pipeline. */
export interface CartItemInput {
  productId: string;
  quantity: number;
  unitPrice?: number;
  discountType?: DiscountType | null;
  discountValue?: number | null;
  discountReason?: string | null;
  /** Fresh approval token (one-shot completion). */
  approvalToken?: string | null;
  /** Approver already recorded on a draft line (completing a draft). */
  approvedByUserId?: string | null;
}

/** A fully computed sale line, ready to persist. */
export interface ComputedLine {
  productId: string;
  productName: string;
  sku: string | null;
  /** Whether the sale should decrement the product's on-hand stock. */
  /** Derived from the QBO item type: only Inventory items decrement stock. */
  trackInventory: boolean;
  unitPrice: number;
  quantity: number;
  discountType: DiscountType | null;
  discountValue: number | null;
  discountAmount: number;
  discountReason: string | null;
  approvedByUserId: string | null;
  taxAmount: number;
  lineSubtotal: number;
  lineTotal: number;
}

/** Order-level (whole-cart) discount input coming into the compute pipeline. */
export interface OrderDiscountInput {
  type?: DiscountType | null;
  value?: number | null;
  reason?: string | null;
  /** Fresh approval token (one-shot completion) for an over-limit order discount. */
  approvalToken?: string | null;
  /** Approver already recorded (completing a draft). */
  approvedById?: string | null;
}

/** Computed sale totals + lines. */
export interface ComputedSale {
  lines: ComputedLine[];
  subtotal: number;
  /** Sum of per-line (product) discounts. */
  totalDiscount: number;
  orderDiscountType: DiscountType | null;
  orderDiscountValue: number | null;
  orderDiscountAmount: number;
  orderDiscountReason: string | null;
  orderDiscountApprovedById: string | null;
  taxAmount: number;
  total: number;
}

export interface PaymentInput {
  method: PaymentMethod;
  amount: number;
  reference?: string | null;
}

/** Everything the repository needs to persist a completed sale. */
export interface PersistSaleInput {
  tenantId: string;
  cashierId: string;
  branchId: string;
  registerId?: string | null;
  customerId?: string | null;
  computed: ComputedSale;
  payments: PaymentInput[];
  paidAmount: number;
  balanceAmount: number;
  paymentStatus: PaymentStatus;
  /**
   * The external accounting document type, or `null` when the tenant has no
   * accounting provider.
   *
   * Widened from non-nullable in Slice 6A. The database column was always
   * nullable; only this input type insisted on a value, which is what would have
   * forced a fabricated document type onto a `NONE` tenant.
   */
  quickbooksDocumentType: QuickBooksDocumentType | null;
  /**
   * The sale's initial sync status, decided by the caller from the accounting
   * provider's own decision — `PENDING` when a push was queued, `NOT_SYNCED` when
   * there is no external accounting.
   *
   * Explicit rather than hardcoded to `PENDING`, because a `NONE` tenant showing
   * "pending sync" forever is a QuickBooks failure state displayed to a user who
   * does not use QuickBooks.
   */
  syncStatus: SyncStatus;
}
