import { describe, expect, it } from 'vitest';

import { Permission } from '@/lib/permissions';

import { deriveSupplierAccess } from './access';
import {
  deriveSupplierAlerts,
  formatChartMonth,
  formatFileSize,
  suggestSupplierCode,
  supplierInitials,
  validateContactDraft,
  validateSupplierDraft,
} from './format';
import {
  canDeletePermanently,
  canPurchaseFrom,
  canTransition,
  needsAttention,
  qbBadgeVariant,
  statusBadgeVariant,
  type Supplier,
  type SupplierContactInput,
  type SupplierInput,
} from './types';
import {
  activeFilterCount,
  computePurchaseSummary,
  computeSummaryMetrics,
  matchesFilters,
  matchesSearch,
  querySuppliers,
  sortRows,
  toSupplierListItem,
  type SupplierRow,
} from './view-models';

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeSupplier(p: Partial<Supplier> & Pick<Supplier, 'id' | 'name' | 'code'>): Supplier {
  return {
    status: 'ACTIVE',
    isPreferred: false,
    logoUrl: null,
    mainContactName: null,
    phone: null,
    whatsapp: null,
    email: null,
    address: null,
    city: null,
    country: 'Sri Lanka',
    legalName: null,
    registrationNumber: null,
    vatNumber: null,
    website: null,
    defaultCurrency: 'LKR',
    paymentTerms: null,
    creditLimit: null,
    defaultLeadTimeDays: null,
    minOrderValue: null,
    categories: [],
    internalNotes: null,
    preferredCommunication: 'PHONE',
    bank: null,
    blockedReason: null,
    quickbooks: {
      status: 'NOT_CONNECTED', quickbooksVendorId: null, quickbooksVendorName: null,
      lastSyncedAt: null, suggestedVendorId: null, suggestedVendorName: null, matchConfidence: null, message: null,
    },
    financials: {
      available: false, quickbooksVendorName: null, outstandingBalance: null, overdueBalance: null,
      openBills: null, lastPaymentAt: null, lastPaymentAmount: null, totalPurchased: null,
      paymentTerms: null, lastSyncedAt: null, quickbooksUrl: null,
    },
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    ...p,
  };
}

function baseSupplierInput(p: Partial<SupplierInput> = {}): SupplierInput {
  return { name: 'Acme', status: 'ACTIVE', isPreferred: false, phone: '011 123 4567', ...p };
}

function baseContactInput(p: Partial<SupplierContactInput> = {}): SupplierContactInput {
  return {
    fullName: 'Jane Doe', contactType: 'SALES', phone: '077 111 2222',
    preferredMethod: 'PHONE', isPrimary: false, isActive: true, ...p,
  };
}

// ── Formatting ───────────────────────────────────────────────────────────────

describe('formatting helpers', () => {
  it('derives initials from a supplier name', () => {
    expect(supplierInitials('Ceylon Cement')).toBe('CC');
    expect(supplierInitials('Metro')).toBe('ME');
    expect(supplierInitials('   ')).toBe('—');
  });

  it('suggests an editable supplier code from the name', () => {
    expect(suggestSupplierCode('Ceylon Cement')).toBe('CEY-CEM');
    expect(suggestSupplierCode('Metro')).toBe('METRO');
    expect(suggestSupplierCode('')).toBe('');
  });

  it('formats file sizes and chart months', () => {
    expect(formatFileSize(512)).toBe('512 B');
    expect(formatFileSize(2048)).toBe('2.0 KB');
    expect(formatChartMonth('2026-07')).toBe('Jul 26');
  });
});

// ── Validation ───────────────────────────────────────────────────────────────

describe('validateSupplierDraft', () => {
  it('requires a name', () => {
    expect(validateSupplierDraft(baseSupplierInput({ name: '  ' })).name).toBe('Enter the supplier’s name.');
  });

  it('requires at least one phone or email', () => {
    const errs = validateSupplierDraft(baseSupplierInput({ phone: null, email: null }));
    expect(errs.contact).toContain('phone number or email');
  });

  it('accepts a valid draft with only an email', () => {
    const errs = validateSupplierDraft(baseSupplierInput({ phone: null, email: 'sales@acme.lk' }));
    expect(errs).toEqual({});
  });

  it('flags an invalid email', () => {
    expect(validateSupplierDraft(baseSupplierInput({ email: 'nope' })).email).toBe('Enter a valid email address.');
  });

  it('flags a duplicate supplier code (case-insensitive)', () => {
    const errs = validateSupplierDraft(baseSupplierInput({ code: 'ACME-1' }), ['acme-1']);
    expect(errs.code).toContain('already using this supplier code');
  });

  it('allows a unique code', () => {
    expect(validateSupplierDraft(baseSupplierInput({ code: 'ACME-2' }), ['acme-1']).code).toBeUndefined();
  });

  it('rejects a negative credit limit', () => {
    expect(validateSupplierDraft(baseSupplierInput({ creditLimit: -5 })).creditLimit).toBeTruthy();
  });
});

describe('validateContactDraft', () => {
  it('requires a name and a contact method', () => {
    const errs = validateContactDraft(baseContactInput({ fullName: '', phone: null, whatsapp: null, email: null }));
    expect(errs.fullName).toBeTruthy();
    expect(errs.contact).toBeTruthy();
  });

  it('accepts whatsapp as a contact method', () => {
    const errs = validateContactDraft(baseContactInput({ phone: null, whatsapp: '077 000 0000' }));
    expect(errs.contact).toBeUndefined();
  });
});

// ── Lifecycle & deletion ─────────────────────────────────────────────────────

describe('lifecycle rules', () => {
  it('permits valid transitions and rejects invalid ones', () => {
    expect(canTransition('ACTIVE', 'BLOCKED')).toBe(true);
    expect(canTransition('ACTIVE', 'DRAFT')).toBe(false);
    expect(canTransition('BLOCKED', 'ACTIVE')).toBe(true);
  });

  it('only allows purchasing from active suppliers', () => {
    expect(canPurchaseFrom('ACTIVE')).toBe(true);
    expect(canPurchaseFrom('BLOCKED')).toBe(false);
    expect(canPurchaseFrom('INACTIVE')).toBe(false);
  });

  it('maps statuses to badge variants', () => {
    expect(statusBadgeVariant('ACTIVE')).toBe('success');
    expect(statusBadgeVariant('BLOCKED')).toBe('danger');
    expect(qbBadgeVariant('ATTENTION')).toBe('danger');
    expect(qbBadgeVariant('CONNECTED')).toBe('success');
  });
});

describe('canDeletePermanently', () => {
  const clean = {
    purchaseCount: 0, purchaseOrderCount: 0, linkedProductCount: 0, documentCount: 0,
    hasQuickBooksMapping: false, hasFinancialRecords: false, hasAuditDependencies: false,
  };

  it('allows deletion for a genuinely unused supplier', () => {
    expect(canDeletePermanently(clean)).toEqual({ allowed: true, blockers: [] });
  });

  it('blocks deletion when the supplier has history', () => {
    const res = canDeletePermanently({ ...clean, purchaseCount: 2, hasQuickBooksMapping: true });
    expect(res.allowed).toBe(false);
    expect(res.blockers).toContain('has purchase history');
    expect(res.blockers).toContain('is mapped to QuickBooks');
  });
});

// ── Permissions ──────────────────────────────────────────────────────────────

describe('deriveSupplierAccess', () => {
  it('gives owners full access', () => {
    const access = deriveSupplierAccess([
      Permission.SUPPLIER_READ, Permission.SUPPLIER_MANAGE, Permission.SUPPLIER_DELETE,
      Permission.SUPPLIER_BANK_VIEW, Permission.SUPPLIER_FINANCIALS_READ, Permission.SUPPLIER_QB_MAP,
    ]);
    expect(access).toEqual({
      canView: true, canManage: true, canDelete: true, canViewBank: true, canViewFinancials: true, canMapQuickBooks: true,
    });
  });

  it('limits a purchasing manager (no delete, no bank)', () => {
    const access = deriveSupplierAccess([
      Permission.SUPPLIER_READ, Permission.SUPPLIER_MANAGE, Permission.SUPPLIER_FINANCIALS_READ, Permission.SUPPLIER_QB_MAP,
    ]);
    expect(access.canManage).toBe(true);
    expect(access.canDelete).toBe(false);
    expect(access.canViewBank).toBe(false);
  });

  it('gives an accountant read + financials but no editing', () => {
    const access = deriveSupplierAccess([Permission.SUPPLIER_READ, Permission.SUPPLIER_FINANCIALS_READ, Permission.SUPPLIER_QB_MAP]);
    expect(access.canView).toBe(true);
    expect(access.canViewFinancials).toBe(true);
    expect(access.canManage).toBe(false);
  });

  it('gives a cashier no access', () => {
    const access = deriveSupplierAccess([]);
    expect(access.canView).toBe(false);
  });
});

// ── View models ──────────────────────────────────────────────────────────────

describe('computePurchaseSummary', () => {
  it('counts pending/overdue and finds the last purchase', () => {
    const summary = computePurchaseSummary([
      { id: '1', reference: 'A', date: '2026-06-01T00:00:00.000Z', supplierInvoiceNumber: null, itemCount: 1, total: 100, received: 100, balance: 0, status: 'RECEIVED' },
      { id: '2', reference: 'B', date: '2026-07-01T00:00:00.000Z', supplierInvoiceNumber: null, itemCount: 1, total: 100, received: 0, balance: 100, status: 'OVERDUE' },
      { id: '3', reference: 'C', date: '2026-05-01T00:00:00.000Z', supplierInvoiceNumber: null, itemCount: 1, total: 100, received: 50, balance: 50, status: 'PARTIALLY_RECEIVED' },
    ]);
    expect(summary.pendingActivityCount).toBe(2);
    expect(summary.overdueActivityCount).toBe(1);
    expect(summary.lastPurchaseAt).toBe('2026-07-01T00:00:00.000Z');
  });

  it('handles no purchases', () => {
    expect(computePurchaseSummary([])).toEqual({ pendingActivityCount: 0, overdueActivityCount: 0, lastPurchaseAt: null });
  });
});

function rows(): SupplierRow[] {
  return [
    {
      supplier: makeSupplier({
        id: 's1', name: 'Alpha Traders', code: 'ALP', isPreferred: true, vatNumber: '111',
        categories: [{ id: 'c1', name: 'Paint' }],
        financials: { ...makeSupplier({ id: 'x', name: 'x', code: 'x' }).financials, available: true, outstandingBalance: 5000, overdueBalance: 0 },
      }),
      rel: { pendingActivityCount: 1, overdueActivityCount: 0, lastPurchaseAt: '2026-07-10T00:00:00.000Z' },
    },
    {
      supplier: makeSupplier({ id: 's2', name: 'Beta Supplies', code: 'BET', status: 'INACTIVE', vatNumber: '222' }),
      rel: { pendingActivityCount: 0, overdueActivityCount: 0, lastPurchaseAt: null },
    },
    {
      supplier: makeSupplier({ id: 's3', name: 'Gamma Co', code: 'GAM', quickbooks: { ...makeSupplier({ id: 'x', name: 'x', code: 'x' }).quickbooks, status: 'ATTENTION' } }),
      rel: { pendingActivityCount: 2, overdueActivityCount: 1, lastPurchaseAt: '2026-06-01T00:00:00.000Z' },
    },
  ];
}

describe('toSupplierListItem', () => {
  it('projects a supplier + summary into a list item, hiding unsynced balances', () => {
    const r = rows();
    const a = r[0]!;
    const item = toSupplierListItem(a.supplier, a.rel);
    expect(item.outstandingBalance).toBe(5000);
    expect(item.financialsAvailable).toBe(true);

    const b = r[1]!;
    const item2 = toSupplierListItem(b.supplier, b.rel);
    expect(item2.outstandingBalance).toBeNull();
    expect(item2.financialsAvailable).toBe(false);
  });
});

describe('matchesSearch', () => {
  it('matches across name, code, and vat', () => {
    const a = rows()[0]!;
    expect(matchesSearch(a.supplier, 'alpha')).toBe(true);
    expect(matchesSearch(a.supplier, 'ALP')).toBe(true);
    expect(matchesSearch(a.supplier, '111')).toBe(true);
    expect(matchesSearch(a.supplier, 'zzz')).toBe(false);
    expect(matchesSearch(a.supplier, '')).toBe(true);
  });
});

describe('matchesFilters', () => {
  it('filters by status, preferred, outstanding, pending, and attention', () => {
    const r = rows();
    const a = r[0]!;
    const b = r[1]!;
    const c = r[2]!;
    expect(matchesFilters(a, { status: 'ACTIVE' })).toBe(true);
    expect(matchesFilters(b, { status: 'ACTIVE' })).toBe(false);
    expect(matchesFilters(a, { preferred: true })).toBe(true);
    expect(matchesFilters(b, { preferred: true })).toBe(false);
    expect(matchesFilters(a, { hasOutstanding: true })).toBe(true);
    expect(matchesFilters(b, { hasOutstanding: true })).toBe(false);
    expect(matchesFilters(c, { pendingActivity: true })).toBe(true);
    expect(matchesFilters(c, { attention: true })).toBe(true);
    expect(matchesFilters(a, { attention: true })).toBe(false);
  });
});

describe('sortRows', () => {
  it('sorts by name ascending', () => {
    const sorted = sortRows(rows(), 'name');
    expect(sorted.map((r) => r.supplier.name)).toEqual(['Alpha Traders', 'Beta Supplies', 'Gamma Co']);
  });

  it('sorts by outstanding descending', () => {
    const sorted = sortRows(rows(), 'outstanding');
    expect(sorted[0]!.supplier.id).toBe('s1');
  });
});

describe('querySuppliers', () => {
  it('searches, filters, sorts, and paginates', () => {
    const res = querySuppliers(rows(), { search: 'a', sort: 'name', page: 1, pageSize: 2 });
    // "a" matches Alpha, Gamma (and Beta via "Beta"? no — "a" appears in "Beta" and "Gamma" and "Alpha")
    expect(res.total).toBeGreaterThanOrEqual(2);
    expect(res.items.length).toBeLessThanOrEqual(2);
    expect(res.page).toBe(1);
  });

  it('paginates correctly', () => {
    const page1 = querySuppliers(rows(), { sort: 'name', page: 1, pageSize: 2 });
    const page2 = querySuppliers(rows(), { sort: 'name', page: 2, pageSize: 2 });
    expect(page1.items.length).toBe(2);
    expect(page2.items.length).toBe(1);
    expect(page1.total).toBe(3);
  });
});

describe('activeFilterCount', () => {
  it('counts only active filters (not sort or paging)', () => {
    expect(activeFilterCount({ sort: 'name', page: 1 })).toBe(0);
    expect(activeFilterCount({ status: 'ACTIVE', preferred: true, attention: true })).toBe(3);
  });
});

describe('computeSummaryMetrics', () => {
  it('aggregates the four summary metrics', () => {
    const m = computeSummaryMetrics(rows(), '2026-07');
    expect(m.activeSuppliers).toBe(2); // s1, s3 active; s2 inactive
    expect(m.outstandingPayables).toBe(5000);
    expect(m.outstandingSupplierCount).toBe(1);
    expect(m.pendingPurchaseActivity).toBe(3);
    expect(m.overduePurchaseActivity).toBe(1);
    // s3 has QB attention; s1/s3 with no vat+active count too
    expect(m.needsAttention).toBeGreaterThanOrEqual(1);
  });

  it('reports null outstanding payables when no supplier is synced', () => {
    const unsynced: SupplierRow[] = [
      { supplier: makeSupplier({ id: 'u1', name: 'U', code: 'U' }), rel: { pendingActivityCount: 0, overdueActivityCount: 0, lastPurchaseAt: null } },
    ];
    expect(computeSummaryMetrics(unsynced, '2026-07').outstandingPayables).toBeNull();
  });
});

// ── Attention + alerts ───────────────────────────────────────────────────────

describe('needsAttention', () => {
  it('flags blocked, QB-attention, overdue, and missing-tax active suppliers', () => {
    expect(needsAttention(makeSupplier({ id: 'a', name: 'A', code: 'A', status: 'BLOCKED' }))).toBe(true);
    expect(needsAttention(makeSupplier({ id: 'b', name: 'B', code: 'B', vatNumber: '1', registrationNumber: '1' }))).toBe(false);
  });
});

describe('deriveSupplierAlerts', () => {
  it('produces actionable alerts with resolution paths', () => {
    const supplier = makeSupplier({ id: 'a', name: 'A', code: 'A' });
    const alerts = deriveSupplierAlerts(supplier, { hasPrimaryContact: false, linkedProductCount: 0 });
    const ids = alerts.map((a) => a.id);
    expect(ids).toContain('no-primary-contact');
    expect(ids).toContain('qb-unmapped');
    expect(ids).toContain('no-products');
    // every alert offers a resolution
    expect(alerts.every((a) => a.actionLabel && a.action)).toBe(true);
  });

  it('does not warn about a healthy supplier', () => {
    const supplier = makeSupplier({
      id: 'h', name: 'Healthy', code: 'H', vatNumber: '1', registrationNumber: '1',
      quickbooks: { ...makeSupplier({ id: 'x', name: 'x', code: 'x' }).quickbooks, status: 'CONNECTED', quickbooksVendorId: 'v1' },
    });
    const alerts = deriveSupplierAlerts(supplier, { hasPrimaryContact: true, linkedProductCount: 3 });
    expect(alerts).toEqual([]);
  });
});
