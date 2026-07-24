/**
 * Supplier (QuickBooks Vendor) — domain types.
 *
 * A supplier is a strict mirror of the QuickBooks Online Vendor record: the
 * fields below are exactly the vendor import template's columns plus system
 * fields. QuickBooks owns vendor financials (bills, payments, live A/P
 * balance); AxloPOS stores only what was entered — never computed balances.
 */

// ── Enums ────────────────────────────────────────────────────────────────────

/** QuickBooks vendor mapping / sync state. */
export type SupplierQbStatus = 'CONNECTED' | 'WAITING' | 'ATTENTION' | 'NOT_CONNECTED';

export const QB_STATUS_LABELS: Record<SupplierQbStatus, string> = {
  CONNECTED: 'Connected',
  WAITING: 'Waiting',
  ATTENTION: 'Attention required',
  NOT_CONNECTED: 'Not connected',
};

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

// ── Core record ──────────────────────────────────────────────────────────────

export interface SupplierQuickBooksMapping {
  status: SupplierQbStatus;
  vendorId: string | null;
  vendorName: string | null;
  lastSyncedAt: string | null;
}

export interface Supplier {
  id: string;
  /** Vendor display name — unique, the import match key. */
  name: string;
  company: string | null;
  email: string | null;
  phone: string | null;
  mobile: string | null;
  fax: string | null;
  website: string | null;
  street: string | null;
  city: string | null;
  /** Province / Region / State. */
  province: string | null;
  postalCode: string | null;
  country: string | null;
  /** Opening balance as entered (QuickBooks owns the live A/P balance). */
  openingBalance: number | null;
  openingBalanceDate: string | null;
  taxId: string | null;
  isActive: boolean;
  quickbooks: SupplierQuickBooksMapping;
  createdAt: string;
  updatedAt: string;
}

// ── Queries & inputs ─────────────────────────────────────────────────────────

export type SupplierSort = 'name' | 'company' | 'dateAdded';

export interface SuppliersQuery {
  page?: number;
  pageSize?: number;
  search?: string;
  /** 'true' | 'false' — undefined shows both. */
  isActive?: string;
  qbStatus?: SupplierQbStatus;
  sort?: SupplierSort;
}

export interface SuppliersPage {
  items: Supplier[];
  total: number;
  page: number;
  pageSize: number;
}

/** Create/update payload — the QuickBooks vendor fields. */
export interface SupplierInput {
  name: string;
  company?: string | null;
  email?: string | null;
  phone?: string | null;
  mobile?: string | null;
  fax?: string | null;
  website?: string | null;
  street?: string | null;
  city?: string | null;
  province?: string | null;
  postalCode?: string | null;
  country?: string | null;
  openingBalance?: number | null;
  openingBalanceDate?: string | null;
  taxId?: string | null;
  isActive?: boolean;
}

// ── QuickBooks vendor search ─────────────────────────────────────────────────

export interface QbVendorOption {
  id: string;
  name: string;
  balance: number | null;
}

// ── Bulk import (two-phase: preview → review → commit) ──────────────────────

export interface ParsedSupplierRow {
  rowNumber: number;
  name: string;
  company: string | null;
  email: string | null;
  phone: string | null;
  mobile: string | null;
  fax: string | null;
  website: string | null;
  street: string | null;
  city: string | null;
  province: string | null;
  postalCode: string | null;
  country: string | null;
  openingBalance: number | null;
  openingBalanceDate: string | null;
  taxId: string | null;
  matchStatus: 'create' | 'update';
  errors: string[];
}

export interface ImportCommitResult {
  rowNumber: number;
  supplierId: string | null;
  outcome: 'created' | 'updated' | 'failed';
  error?: string;
}

export interface ImportCommitSummary {
  created: number;
  updated: number;
  failed: number;
  results: ImportCommitResult[];
}
