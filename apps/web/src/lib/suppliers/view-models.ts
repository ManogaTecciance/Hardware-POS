/**
 * Supplier Management — pure view-model derivations.
 *
 * These functions turn domain records into the shapes the UI renders and
 * implement list search/filter/sort/paginate. They are pure and unit-tested so
 * no filtering or aggregation logic lives in presentational components.
 */

import {
  needsAttention,
  type Supplier,
  type SupplierListItem,
  type SupplierPurchase,
  type SupplierSort,
  type SupplierSummaryMetrics,
  type SuppliersQuery,
  type PurchaseStatus,
} from './types';

/** Purchase statuses that count as "pending activity". */
const PENDING_STATUSES: PurchaseStatus[] = ['DRAFT', 'SENT', 'PARTIALLY_RECEIVED', 'OVERDUE'];

export interface SupplierRelatedSummary {
  pendingActivityCount: number;
  overdueActivityCount: number;
  lastPurchaseAt: string | null;
}

/** Derive pending/overdue counts and the most recent purchase date. */
export function computePurchaseSummary(purchases: SupplierPurchase[]): SupplierRelatedSummary {
  let pendingActivityCount = 0;
  let overdueActivityCount = 0;
  let lastPurchaseAt: string | null = null;
  for (const p of purchases) {
    if (PENDING_STATUSES.includes(p.status)) pendingActivityCount += 1;
    if (p.status === 'OVERDUE') overdueActivityCount += 1;
    if (!lastPurchaseAt || p.date > lastPurchaseAt) lastPurchaseAt = p.date;
  }
  return { pendingActivityCount, overdueActivityCount, lastPurchaseAt };
}

export function toSupplierListItem(
  s: Supplier,
  rel: SupplierRelatedSummary,
): SupplierListItem {
  return {
    id: s.id,
    name: s.name,
    code: s.code,
    logoUrl: s.logoUrl,
    isPreferred: s.isPreferred,
    status: s.status,
    mainContactName: s.mainContactName,
    mainContactPhone: s.phone,
    mainContactEmail: s.email,
    categories: s.categories,
    outstandingBalance: s.financials.available ? s.financials.outstandingBalance : null,
    financialsAvailable: s.financials.available,
    pendingActivityCount: rel.pendingActivityCount,
    overdueActivityCount: rel.overdueActivityCount,
    lastPurchaseAt: rel.lastPurchaseAt,
    qbStatus: s.quickbooks.status,
  };
}

/** Case-insensitive match across all searchable supplier fields. */
export function matchesSearch(s: Supplier, rawTerm: string): boolean {
  const term = rawTerm.trim().toLowerCase();
  if (!term) return true;
  const haystack = [
    s.name,
    s.code,
    s.mainContactName,
    s.phone,
    s.whatsapp,
    s.email,
    s.registrationNumber,
    s.vatNumber,
    s.quickbooks.quickbooksVendorName,
  ];
  return haystack.some((v) => (v ?? '').toLowerCase().includes(term));
}

export interface SupplierRow {
  supplier: Supplier;
  rel: SupplierRelatedSummary;
}

/** Apply all non-search filters from the query. */
export function matchesFilters(row: SupplierRow, q: SuppliersQuery): boolean {
  const { supplier: s, rel } = row;
  if (q.status && s.status !== q.status) return false;
  if (q.preferred && !s.isPreferred) return false;
  if (q.qbStatus && s.quickbooks.status !== q.qbStatus) return false;
  if (q.categoryId && !s.categories.some((c) => c.id === q.categoryId)) return false;
  if (q.hasOutstanding) {
    if (!s.financials.available || !(s.financials.outstandingBalance ?? 0) || (s.financials.outstandingBalance ?? 0) <= 0) {
      return false;
    }
  }
  if (q.overdue) {
    const overdueBal = s.financials.available ? s.financials.overdueBalance ?? 0 : 0;
    if (overdueBal <= 0 && rel.overdueActivityCount === 0) return false;
  }
  if (q.pendingActivity && rel.pendingActivityCount === 0) return false;
  if (q.attention && !needsAttention(s)) return false;
  return true;
}

function sortValue(row: SupplierRow, sort: SupplierSort): number | string {
  const { supplier: s, rel } = row;
  switch (sort) {
    case 'name':
      return s.name.toLowerCase();
    case 'outstanding':
      return s.financials.available ? s.financials.outstandingBalance ?? 0 : -1;
    case 'lastPurchase':
      return rel.lastPurchaseAt ?? '';
    case 'dateAdded':
      return s.createdAt;
    case 'pendingActivity':
      return rel.pendingActivityCount;
    case 'status':
      return s.status;
  }
}

export function sortRows(rows: SupplierRow[], sort: SupplierSort = 'name'): SupplierRow[] {
  const dir = sort === 'name' || sort === 'status' ? 1 : -1; // name/status ascending, rest descending
  return [...rows].sort((a, b) => {
    const av = sortValue(a, sort);
    const bv = sortValue(b, sort);
    if (av < bv) return -1 * dir;
    if (av > bv) return 1 * dir;
    return a.supplier.name.localeCompare(b.supplier.name);
  });
}

export interface FilteredResult {
  items: SupplierListItem[];
  total: number;
  page: number;
  pageSize: number;
}

/** Full list pipeline: search → filter → sort → paginate → project. */
export function querySuppliers(rows: SupplierRow[], q: SuppliersQuery): FilteredResult {
  const page = Math.max(1, q.page ?? 1);
  const pageSize = Math.max(1, q.pageSize ?? 20);
  const filtered = rows
    .filter((r) => matchesSearch(r.supplier, q.search ?? ''))
    .filter((r) => matchesFilters(r, q));
  const sorted = sortRows(filtered, q.sort ?? 'name');
  const start = (page - 1) * pageSize;
  const pageRows = sorted.slice(start, start + pageSize);
  return {
    items: pageRows.map((r) => toSupplierListItem(r.supplier, r.rel)),
    total: filtered.length,
    page,
    pageSize,
  };
}

/** Count of active filters shown next to "Clear filters". */
export function activeFilterCount(q: SuppliersQuery): number {
  let n = 0;
  if (q.status) n += 1;
  if (q.preferred) n += 1;
  if (q.hasOutstanding) n += 1;
  if (q.overdue) n += 1;
  if (q.pendingActivity) n += 1;
  if (q.attention) n += 1;
  if (q.qbStatus) n += 1;
  if (q.categoryId) n += 1;
  return n;
}

/** Aggregate the four summary-card metrics from the full supplier set. */
export function computeSummaryMetrics(
  rows: SupplierRow[],
  thisMonthPrefix: string, // e.g. "2026-07"
): SupplierSummaryMetrics {
  let activeSuppliers = 0;
  let activeAddedThisMonth = 0;
  let outstandingPayables = 0;
  let outstandingSupplierCount = 0;
  let anyFinancials = false;
  let pendingPurchaseActivity = 0;
  let overduePurchaseActivity = 0;
  let needsAttentionCount = 0;

  for (const { supplier: s, rel } of rows) {
    if (s.status === 'ACTIVE') {
      activeSuppliers += 1;
      if (s.createdAt.startsWith(thisMonthPrefix)) activeAddedThisMonth += 1;
    }
    if (s.financials.available) {
      anyFinancials = true;
      const bal = s.financials.outstandingBalance ?? 0;
      outstandingPayables += bal;
      if (bal > 0) outstandingSupplierCount += 1;
    }
    pendingPurchaseActivity += rel.pendingActivityCount;
    overduePurchaseActivity += rel.overdueActivityCount;

    if (needsAttention(s)) needsAttentionCount += 1;
  }

  return {
    activeSuppliers,
    activeAddedThisMonth,
    outstandingPayables: anyFinancials ? outstandingPayables : null,
    outstandingSupplierCount,
    pendingPurchaseActivity,
    overduePurchaseActivity,
    needsAttention: needsAttentionCount,
  };
}
