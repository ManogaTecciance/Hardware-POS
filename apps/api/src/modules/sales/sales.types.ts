import {
  DiscountType,
  PaymentMethod,
  PaymentStatus,
  QuickBooksDocumentType,
  SaleReturnStatus,
  SaleStatus,
  SyncStatus,
} from '@hardware-pos/database';

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
  /** When payment is expected. Null on a fully paid sale — the column stays blank. */
  paymentDueDate: Date | null;
  /** When the most recent payment was received. Null when none has been. */
  lastPaymentAt: Date | null;
  returnStatus: SaleReturnStatus;
  returnedAmount: number;
  quickbooksDocumentType: QuickBooksDocumentType | null;
  syncStatus: SyncStatus;
}

/** Filters accepted by the sales history list. */
export interface SalesListFilter {
  syncStatus?: SyncStatus;
  paymentStatus?: PaymentStatus;
  search?: string;
  dateFrom?: Date;
  dateTo?: Date;
  /** Only sales past their due date that still owe money. */
  overdueAsOf?: Date;
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
  /** Invoice date — the user-chosen sale date, or now. Stored as `completedAt`. */
  saleDate: Date;
  /** When payment is expected. Null on a fully paid sale. */
  paymentDueDate: Date | null;
  computed: ComputedSale;
  payments: PaymentInput[];
  paidAmount: number;
  balanceAmount: number;
  paymentStatus: PaymentStatus;
  quickbooksDocumentType: QuickBooksDocumentType;
}
