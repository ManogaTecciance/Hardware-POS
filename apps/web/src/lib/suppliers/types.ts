/**
 * Supplier Management — domain types, enums, and pure view-model helpers.
 *
 * AxloPOS owns operational supplier data (contacts, product links, notes,
 * documents, status). QuickBooks Online owns supplier financials (bills,
 * payments, A/P balance) — represented here read-only via the QuickBooks
 * mapping + financial-summary view models. No accounting balance is ever
 * computed on the AxloPOS side; those numbers come from QuickBooks as-is.
 */

// ── Enums ────────────────────────────────────────────────────────────────────

/** Operational lifecycle state (AxloPOS-owned). */
export type SupplierStatus = 'ACTIVE' | 'INACTIVE' | 'BLOCKED' | 'DRAFT';

/** QuickBooks vendor mapping / sync state. */
export type SupplierQbStatus =
  | 'CONNECTED'
  | 'WAITING'
  | 'ATTENTION'
  | 'NOT_CONNECTED';

export type SupplierContactType =
  | 'PRIMARY'
  | 'SALES'
  | 'ACCOUNTS'
  | 'DELIVERY'
  | 'TECHNICAL'
  | 'OTHER';

export type CommunicationMethod = 'PHONE' | 'WHATSAPP' | 'EMAIL';

export type PurchaseStatus =
  | 'DRAFT'
  | 'SENT'
  | 'PARTIALLY_RECEIVED'
  | 'RECEIVED'
  | 'CANCELLED'
  | 'OVERDUE';

export type SupplierDocumentType =
  | 'AGREEMENT'
  | 'QUOTATION'
  | 'PRICE_LIST'
  | 'TAX'
  | 'WARRANTY'
  | 'INVOICE'
  | 'OTHER';

// ── Label maps (single source of truth for user-facing text) ─────────────────

export const SUPPLIER_STATUS_LABELS: Record<SupplierStatus, string> = {
  ACTIVE: 'Active',
  INACTIVE: 'Inactive',
  BLOCKED: 'Blocked',
  DRAFT: 'Draft',
};

export const QB_STATUS_LABELS: Record<SupplierQbStatus, string> = {
  CONNECTED: 'Connected',
  WAITING: 'Waiting',
  ATTENTION: 'Attention required',
  NOT_CONNECTED: 'Not connected',
};

export const CONTACT_TYPE_LABELS: Record<SupplierContactType, string> = {
  PRIMARY: 'Primary',
  SALES: 'Sales',
  ACCOUNTS: 'Accounts',
  DELIVERY: 'Delivery',
  TECHNICAL: 'Technical',
  OTHER: 'Other',
};

export const COMMUNICATION_LABELS: Record<CommunicationMethod, string> = {
  PHONE: 'Phone',
  WHATSAPP: 'WhatsApp',
  EMAIL: 'Email',
};

export const PURCHASE_STATUS_LABELS: Record<PurchaseStatus, string> = {
  DRAFT: 'Draft',
  SENT: 'Sent',
  PARTIALLY_RECEIVED: 'Partially received',
  RECEIVED: 'Received',
  CANCELLED: 'Cancelled',
  OVERDUE: 'Overdue',
};

export const DOCUMENT_TYPE_LABELS: Record<SupplierDocumentType, string> = {
  AGREEMENT: 'Agreement',
  QUOTATION: 'Quotation',
  PRICE_LIST: 'Price list',
  TAX: 'Tax document',
  WARRANTY: 'Warranty',
  INVOICE: 'Invoice',
  OTHER: 'Other',
};

// ── Core records ─────────────────────────────────────────────────────────────

export interface SupplierCategoryRef {
  id: string;
  name: string;
}

/** Bank / payment details — permission-gated and masked on read. */
export interface SupplierBankDetails {
  bankName: string | null;
  accountHolder: string | null;
  /** Server returns a masked value (e.g. `•••• 4321`) unless explicitly revealed. */
  accountNumberMasked: string | null;
  branch: string | null;
  preferredPaymentMethod: string | null;
}

export interface SupplierContact {
  id: string;
  fullName: string;
  jobTitle: string | null;
  contactType: SupplierContactType;
  phone: string | null;
  whatsapp: string | null;
  email: string | null;
  preferredMethod: CommunicationMethod;
  isPrimary: boolean;
  isActive: boolean;
}

export interface SupplierProductLink {
  id: string;
  productId: string;
  productName: string;
  productSku: string | null;
  supplierSku: string | null;
  currentCost: number | null;
  lastCost: number | null;
  minOrderQty: number | null;
  leadTimeDays: number | null;
  lastPurchasedAt: string | null;
  isPreferredSupplier: boolean;
  isActive: boolean;
}

export interface SupplierPurchase {
  id: string;
  reference: string;
  date: string;
  supplierInvoiceNumber: string | null;
  itemCount: number;
  total: number;
  received: number;
  balance: number;
  status: PurchaseStatus;
}

export interface SupplierDocument {
  id: string;
  fileName: string;
  docType: SupplierDocumentType;
  uploadedBy: string;
  uploadedAt: string;
  sizeBytes: number;
  url: string | null;
}

export interface SupplierNote {
  id: string;
  body: string;
  author: string;
  createdAt: string;
  pinned: boolean;
}

/**
 * QuickBooks financial summary — READ-ONLY mirror of QuickBooks Online.
 * AxloPOS never edits these values. `available: false` means the supplier is
 * not connected / data is unavailable, and the UI shows an empty state rather
 * than fabricated numbers.
 */
export interface SupplierFinancialSummary {
  available: boolean;
  quickbooksVendorName: string | null;
  outstandingBalance: number | null;
  overdueBalance: number | null;
  openBills: number | null;
  lastPaymentAt: string | null;
  lastPaymentAmount: number | null;
  totalPurchased: number | null;
  paymentTerms: string | null;
  lastSyncedAt: string | null;
  /** Deep link into QuickBooks Online, when known. */
  quickbooksUrl: string | null;
}

export interface SupplierQuickBooksMapping {
  status: SupplierQbStatus;
  quickbooksVendorId: string | null;
  quickbooksVendorName: string | null;
  lastSyncedAt: string | null;
  /** Present only when a suggested (unconfirmed) match exists. */
  suggestedVendorId: string | null;
  suggestedVendorName: string | null;
  /** 0–1 confidence for a suggested match; null when no real matching exists. */
  matchConfidence: number | null;
  message: string | null;
}

/** Monthly purchase-activity point for the optional overview chart. */
export interface SupplierPurchasePoint {
  month: string; // ISO YYYY-MM
  value: number;
}

// ── Supplier aggregate ───────────────────────────────────────────────────────

export interface Supplier {
  id: string;
  name: string;
  code: string;
  status: SupplierStatus;
  isPreferred: boolean;
  logoUrl: string | null;

  // Essential contact
  mainContactName: string | null;
  phone: string | null;
  whatsapp: string | null;
  email: string | null;
  address: string | null;
  city: string | null;
  country: string | null;

  // Additional business details
  legalName: string | null;
  registrationNumber: string | null;
  vatNumber: string | null;
  website: string | null;
  defaultCurrency: string | null;
  paymentTerms: string | null;
  creditLimit: number | null;
  defaultLeadTimeDays: number | null;
  minOrderValue: number | null;
  categories: SupplierCategoryRef[];
  internalNotes: string | null;
  preferredCommunication: CommunicationMethod | null;

  // Bank details (permission-gated; masked)
  bank: SupplierBankDetails | null;

  // Lifecycle
  blockedReason: string | null;

  // QuickBooks (read-only mirror)
  quickbooks: SupplierQuickBooksMapping;
  financials: SupplierFinancialSummary;

  createdAt: string;
  updatedAt: string;
}

// ── List / query view models ─────────────────────────────────────────────────

export interface SupplierListItem {
  id: string;
  name: string;
  code: string;
  logoUrl: string | null;
  isPreferred: boolean;
  status: SupplierStatus;
  mainContactName: string | null;
  mainContactPhone: string | null;
  mainContactEmail: string | null;
  categories: SupplierCategoryRef[];
  outstandingBalance: number | null;
  financialsAvailable: boolean;
  pendingActivityCount: number;
  overdueActivityCount: number;
  lastPurchaseAt: string | null;
  qbStatus: SupplierQbStatus;
}

export interface SuppliersPage {
  items: SupplierListItem[];
  total: number;
  page: number;
  pageSize: number;
}

export interface SupplierSummaryMetrics {
  activeSuppliers: number;
  activeAddedThisMonth: number;
  outstandingPayables: number | null;
  outstandingSupplierCount: number;
  pendingPurchaseActivity: number;
  overduePurchaseActivity: number;
  needsAttention: number;
}

export type SupplierSort =
  | 'name'
  | 'outstanding'
  | 'lastPurchase'
  | 'dateAdded'
  | 'pendingActivity'
  | 'status';

export interface SuppliersQuery {
  page?: number;
  pageSize?: number;
  search?: string;
  status?: SupplierStatus;
  preferred?: boolean;
  hasOutstanding?: boolean;
  overdue?: boolean;
  pendingActivity?: boolean;
  /** Suppliers with sync, documentation, or payment issues. */
  attention?: boolean;
  qbStatus?: SupplierQbStatus;
  categoryId?: string;
  sort?: SupplierSort;
}

/** True when a supplier needs attention (sync, documentation, or payment issues). */
export function needsAttention(s: Supplier): boolean {
  return (
    s.quickbooks.status === 'ATTENTION' ||
    s.status === 'BLOCKED' ||
    (s.financials.available && (s.financials.overdueBalance ?? 0) > 0) ||
    (!s.vatNumber && !s.registrationNumber && s.status === 'ACTIVE')
  );
}

// ── Inputs ───────────────────────────────────────────────────────────────────

export interface SupplierInput {
  name: string;
  code?: string;
  status: SupplierStatus;
  isPreferred: boolean;
  mainContactName?: string | null;
  phone?: string | null;
  whatsapp?: string | null;
  email?: string | null;
  address?: string | null;
  city?: string | null;
  country?: string | null;
  legalName?: string | null;
  registrationNumber?: string | null;
  vatNumber?: string | null;
  website?: string | null;
  defaultCurrency?: string | null;
  paymentTerms?: string | null;
  creditLimit?: number | null;
  defaultLeadTimeDays?: number | null;
  minOrderValue?: number | null;
  categoryIds?: string[];
  internalNotes?: string | null;
  preferredCommunication?: CommunicationMethod | null;
  /** Bank details are permission-gated and never stored client-side. */
  bank?: SupplierBankInput | null;
}

export interface SupplierBankInput {
  bankName?: string | null;
  accountHolder?: string | null;
  /** Raw account number; the server persists a masked form. */
  accountNumber?: string | null;
  branch?: string | null;
  preferredPaymentMethod?: string | null;
}

export interface SupplierContactInput {
  fullName: string;
  jobTitle?: string | null;
  contactType: SupplierContactType;
  phone?: string | null;
  whatsapp?: string | null;
  email?: string | null;
  preferredMethod: CommunicationMethod;
  isPrimary: boolean;
  isActive: boolean;
}

export interface SupplierProductLinkInput {
  productId: string;
  supplierSku?: string | null;
  currentCost?: number | null;
  minOrderQty?: number | null;
  leadTimeDays?: number | null;
  isPreferredSupplier?: boolean;
}

// ── Pure domain helpers (unit-tested) ────────────────────────────────────────

/** Badge variant to use for a lifecycle status. */
export function statusBadgeVariant(
  status: SupplierStatus,
): 'success' | 'neutral' | 'danger' | 'warning' {
  switch (status) {
    case 'ACTIVE':
      return 'success';
    case 'INACTIVE':
      return 'neutral';
    case 'BLOCKED':
      return 'danger';
    case 'DRAFT':
      return 'warning';
  }
}

/** Badge variant for a QuickBooks status. */
export function qbBadgeVariant(
  status: SupplierQbStatus,
): 'success' | 'warning' | 'danger' | 'neutral' {
  switch (status) {
    case 'CONNECTED':
      return 'success';
    case 'WAITING':
      return 'warning';
    case 'ATTENTION':
      return 'danger';
    case 'NOT_CONNECTED':
      return 'neutral';
  }
}

/** Allowed lifecycle transitions (UI + guard rails; backend re-validates). */
export const ALLOWED_TRANSITIONS: Record<SupplierStatus, SupplierStatus[]> = {
  DRAFT: ['ACTIVE', 'INACTIVE'],
  ACTIVE: ['INACTIVE', 'BLOCKED'],
  INACTIVE: ['ACTIVE', 'BLOCKED'],
  BLOCKED: ['ACTIVE', 'INACTIVE'],
};

export function canTransition(from: SupplierStatus, to: SupplierStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/** True when a supplier may accept new purchasing selections. */
export function canPurchaseFrom(status: SupplierStatus): boolean {
  return status === 'ACTIVE';
}

/**
 * Dependencies that block permanent deletion. Any truthy field means the
 * supplier has history and must be deactivated instead of deleted.
 */
export interface SupplierDeleteDependencies {
  purchaseCount: number;
  purchaseOrderCount: number;
  linkedProductCount: number;
  documentCount: number;
  hasQuickBooksMapping: boolean;
  hasFinancialRecords: boolean;
  hasAuditDependencies: boolean;
}

export interface DeleteEligibility {
  allowed: boolean;
  /** Human-readable reasons deletion is blocked (empty when allowed). */
  blockers: string[];
}

/** Permanent deletion is allowed only for genuinely unused records. */
export function canDeletePermanently(
  deps: SupplierDeleteDependencies,
): DeleteEligibility {
  const blockers: string[] = [];
  if (deps.purchaseCount > 0) blockers.push('has purchase history');
  if (deps.purchaseOrderCount > 0) blockers.push('has purchase orders');
  if (deps.linkedProductCount > 0) blockers.push('has linked products');
  if (deps.documentCount > 0) blockers.push('has uploaded documents');
  if (deps.hasQuickBooksMapping) blockers.push('is mapped to QuickBooks');
  if (deps.hasFinancialRecords) blockers.push('has financial records');
  if (deps.hasAuditDependencies) blockers.push('has audit dependencies');
  return { allowed: blockers.length === 0, blockers };
}
