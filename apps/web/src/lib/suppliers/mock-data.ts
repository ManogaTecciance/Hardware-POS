/**
 * ISOLATED development mock for Supplier Management.
 *
 * This module is the ONLY source of demo supplier data and is used solely when
 * the supplier backend module is unavailable and mock mode is explicitly on
 * (see `suppliers-api.ts`). Data here is fabricated and clearly labelled in the
 * UI as "Demo data". It must never be mixed silently with live data, and no
 * financial figure here is authoritative — QuickBooks Online remains the source
 * of truth in production.
 *
 * All timestamps are fixed ISO strings (no Date.now()/random) so the mock is
 * deterministic and SSR/hydration-safe.
 */

import type {
  Supplier,
  SupplierContact,
  SupplierDocument,
  SupplierNote,
  SupplierProductLink,
  SupplierPurchase,
  SupplierPurchasePoint,
} from './types';

function qb(
  status: Supplier['quickbooks']['status'],
  vendorId: string | null,
  vendorName: string | null,
  lastSyncedAt: string | null,
): Supplier['quickbooks'] {
  return {
    status,
    quickbooksVendorId: vendorId,
    quickbooksVendorName: vendorName,
    lastSyncedAt,
    suggestedVendorId: null,
    suggestedVendorName: null,
    matchConfidence: null,
    message: null,
  };
}

function fin(
  available: boolean,
  vendorName: string | null,
  outstanding: number | null,
  overdue: number | null,
  openBills: number | null,
  lastSyncedAt: string | null,
): Supplier['financials'] {
  return {
    available,
    quickbooksVendorName: vendorName,
    outstandingBalance: outstanding,
    overdueBalance: overdue,
    openBills,
    lastPaymentAt: available ? '2026-06-28T00:00:00.000Z' : null,
    lastPaymentAmount: available ? 85000 : null,
    totalPurchased: available ? (outstanding ?? 0) * 6 + 420000 : null,
    paymentTerms: available ? 'Net 30' : null,
    lastSyncedAt,
    quickbooksUrl: available ? 'https://qbo.intuit.com/app/vendordetail' : null,
  };
}

const CATS = {
  building: { id: 'cat_building', name: 'Building Materials' },
  paint: { id: 'cat_paint', name: 'Paint & Supplies' },
  plumbing: { id: 'cat_plumbing', name: 'Plumbing' },
  electrical: { id: 'cat_electrical', name: 'Electrical' },
  tools: { id: 'cat_tools', name: 'Tools & Hardware' },
  safety: { id: 'cat_safety', name: 'Safety Equipment' },
};

function base(partial: Partial<Supplier> & Pick<Supplier, 'id' | 'name' | 'code'>): Supplier {
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
    quickbooks: qb('NOT_CONNECTED', null, null, null),
    financials: fin(false, null, null, null, null, null),
    createdAt: '2026-01-10T00:00:00.000Z',
    updatedAt: '2026-06-30T00:00:00.000Z',
    ...partial,
  };
}

export const MOCK_SUPPLIERS: Supplier[] = [
  base({
    id: 'sup_001',
    name: 'Ceylon Cement & Building Supplies',
    code: 'CEY-CEM',
    status: 'ACTIVE',
    isPreferred: true,
    mainContactName: 'Nimal Fernando',
    phone: '011 234 5678',
    whatsapp: '077 234 5678',
    email: 'sales@ceyloncement.lk',
    address: '142 Baseline Road',
    city: 'Colombo 09',
    legalName: 'Ceylon Cement & Building Supplies (Pvt) Ltd',
    registrationNumber: 'PV 12345',
    vatNumber: '134567890-7000',
    website: 'https://ceyloncement.lk',
    paymentTerms: 'Net 30',
    creditLimit: 2000000,
    defaultLeadTimeDays: 3,
    minOrderValue: 50000,
    categories: [CATS.building, CATS.plumbing],
    preferredCommunication: 'PHONE',
    bank: {
      bankName: 'Commercial Bank',
      accountHolder: 'Ceylon Cement & Building Supplies (Pvt) Ltd',
      accountNumberMasked: '•••• 4321',
      branch: 'Maradana',
      preferredPaymentMethod: 'Bank transfer',
    },
    quickbooks: qb('CONNECTED', 'qbv_58', 'Ceylon Cement & Building', '2026-07-20T06:00:00.000Z'),
    financials: fin(true, 'Ceylon Cement & Building', 845000, 120000, 4, '2026-07-20T06:00:00.000Z'),
    createdAt: '2026-01-10T00:00:00.000Z',
  }),
  base({
    id: 'sup_002',
    name: 'Lanka Paints Distributors',
    code: 'LAN-PAI',
    status: 'ACTIVE',
    isPreferred: true,
    mainContactName: 'Shirani Perera',
    phone: '011 555 8899',
    email: 'orders@lankapaints.lk',
    city: 'Kelaniya',
    vatNumber: '998877665-7000',
    paymentTerms: 'Net 15',
    categories: [CATS.paint],
    quickbooks: qb('CONNECTED', 'qbv_71', 'Lanka Paints', '2026-07-19T06:00:00.000Z'),
    financials: fin(true, 'Lanka Paints', 210000, 0, 2, '2026-07-19T06:00:00.000Z'),
    createdAt: '2026-02-02T00:00:00.000Z',
  }),
  base({
    id: 'sup_003',
    name: 'Highway Electricals',
    code: 'HIG-ELE',
    status: 'ACTIVE',
    mainContactName: 'Roshan Silva',
    phone: '081 220 1144',
    email: 'info@highwayelec.lk',
    city: 'Kandy',
    categories: [CATS.electrical, CATS.tools],
    quickbooks: qb('WAITING', null, null, null),
    financials: fin(false, null, null, null, null, null),
    createdAt: '2026-03-15T00:00:00.000Z',
  }),
  base({
    id: 'sup_004',
    name: 'Metro Plumbing Warehouse',
    code: 'MET-PLU',
    status: 'ACTIVE',
    mainContactName: 'Kasun Jayasuriya',
    phone: '011 778 4520',
    email: 'sales@metroplumbing.lk',
    city: 'Nugegoda',
    categories: [CATS.plumbing],
    quickbooks: qb('ATTENTION', 'qbv_90', 'Metro Plumbing', '2026-07-10T06:00:00.000Z'),
    financials: fin(true, 'Metro Plumbing', 96000, 96000, 1, '2026-07-10T06:00:00.000Z'),
    createdAt: '2026-03-28T00:00:00.000Z',
  }),
  base({
    id: 'sup_005',
    name: 'SafeGuard Industrial',
    code: 'SAF-IND',
    status: 'ACTIVE',
    mainContactName: 'Dilani Wickrama',
    phone: '011 900 3321',
    email: 'contact@safeguard.lk',
    city: 'Ratmalana',
    categories: [CATS.safety, CATS.tools],
    quickbooks: qb('NOT_CONNECTED', null, null, null),
    createdAt: '2026-07-05T00:00:00.000Z',
  }),
  base({
    id: 'sup_006',
    name: 'Northern Steel Traders',
    code: 'NOR-STE',
    status: 'INACTIVE',
    mainContactName: 'Ahilan Raj',
    phone: '021 222 4567',
    city: 'Jaffna',
    categories: [CATS.building],
    quickbooks: qb('CONNECTED', 'qbv_33', 'Northern Steel', '2026-05-01T06:00:00.000Z'),
    financials: fin(true, 'Northern Steel', 0, 0, 0, '2026-05-01T06:00:00.000Z'),
    createdAt: '2025-11-20T00:00:00.000Z',
  }),
  base({
    id: 'sup_007',
    name: 'Apex Tools Import',
    code: 'APE-TOO',
    status: 'BLOCKED',
    blockedReason: 'Repeated quality issues on last three deliveries',
    mainContactName: 'Suresh Menon',
    phone: '011 445 9080',
    email: 'apex@apextools.lk',
    city: 'Colombo 14',
    categories: [CATS.tools],
    quickbooks: qb('CONNECTED', 'qbv_44', 'Apex Tools', '2026-06-15T06:00:00.000Z'),
    financials: fin(true, 'Apex Tools', 55000, 55000, 1, '2026-06-15T06:00:00.000Z'),
    createdAt: '2026-01-25T00:00:00.000Z',
  }),
  base({
    id: 'sup_008',
    name: 'Green Valley Timber',
    code: 'GRE-TIM',
    status: 'DRAFT',
    mainContactName: 'Malith Bandara',
    phone: '033 228 7711',
    categories: [CATS.building],
    createdAt: '2026-07-18T00:00:00.000Z',
  }),
];

const CONTACTS: Record<string, SupplierContact[]> = {
  sup_001: [
    {
      id: 'con_1', fullName: 'Nimal Fernando', jobTitle: 'Sales Manager', contactType: 'PRIMARY',
      phone: '011 234 5678', whatsapp: '077 234 5678', email: 'nimal@ceyloncement.lk',
      preferredMethod: 'PHONE', isPrimary: true, isActive: true,
    },
    {
      id: 'con_2', fullName: 'Anoma Gunawardena', jobTitle: 'Accounts Executive', contactType: 'ACCOUNTS',
      phone: '011 234 5679', whatsapp: null, email: 'accounts@ceyloncement.lk',
      preferredMethod: 'EMAIL', isPrimary: false, isActive: true,
    },
    {
      id: 'con_3', fullName: 'Sunil Rathnayake', jobTitle: 'Delivery Coordinator', contactType: 'DELIVERY',
      phone: '077 999 1212', whatsapp: '077 999 1212', email: null,
      preferredMethod: 'WHATSAPP', isPrimary: false, isActive: true,
    },
  ],
  sup_002: [
    {
      id: 'con_4', fullName: 'Shirani Perera', jobTitle: 'Distributor Lead', contactType: 'PRIMARY',
      phone: '011 555 8899', whatsapp: null, email: 'shirani@lankapaints.lk',
      preferredMethod: 'EMAIL', isPrimary: true, isActive: true,
    },
  ],
  sup_004: [
    {
      id: 'con_5', fullName: 'Kasun Jayasuriya', jobTitle: 'Owner', contactType: 'SALES',
      phone: '011 778 4520', whatsapp: '071 778 4520', email: 'sales@metroplumbing.lk',
      preferredMethod: 'PHONE', isPrimary: false, isActive: true,
    },
  ],
};

const PRODUCTS: Record<string, SupplierProductLink[]> = {
  sup_001: [
    {
      id: 'spl_1', productId: 'prod_cement', productName: 'Tokyo Cement 50kg', productSku: 'CEM-TOK-50',
      supplierSku: 'TC-50', currentCost: 2450, lastCost: 2380, minOrderQty: 40, leadTimeDays: 3,
      lastPurchasedAt: '2026-07-12T00:00:00.000Z', isPreferredSupplier: true, isActive: true,
    },
    {
      id: 'spl_2', productId: 'prod_sand', productName: 'River Sand (cube)', productSku: 'SAN-RIV',
      supplierSku: 'RS-CUBE', currentCost: 32000, lastCost: 31000, minOrderQty: 1, leadTimeDays: 2,
      lastPurchasedAt: '2026-07-05T00:00:00.000Z', isPreferredSupplier: false, isActive: true,
    },
  ],
  sup_002: [
    {
      id: 'spl_3', productId: 'prod_emulsion', productName: 'Weathershield Emulsion 4L', productSku: 'PAI-WS-4',
      supplierSku: 'WS-4L', currentCost: 4800, lastCost: 4800, minOrderQty: 6, leadTimeDays: 5,
      lastPurchasedAt: '2026-06-30T00:00:00.000Z', isPreferredSupplier: true, isActive: true,
    },
  ],
};

const PURCHASES: Record<string, SupplierPurchase[]> = {
  sup_001: [
    {
      id: 'pur_1', reference: 'PO-2026-0142', date: '2026-07-12T00:00:00.000Z',
      supplierInvoiceNumber: 'INV-88213', itemCount: 3, total: 245000, received: 245000, balance: 0,
      status: 'RECEIVED',
    },
    {
      id: 'pur_2', reference: 'PO-2026-0131', date: '2026-06-28T00:00:00.000Z',
      supplierInvoiceNumber: 'INV-87990', itemCount: 5, total: 512000, received: 300000, balance: 212000,
      status: 'PARTIALLY_RECEIVED',
    },
    {
      id: 'pur_3', reference: 'PO-2026-0120', date: '2026-06-05T00:00:00.000Z',
      supplierInvoiceNumber: 'INV-87540', itemCount: 2, total: 120000, received: 0, balance: 120000,
      status: 'OVERDUE',
    },
  ],
  sup_002: [
    {
      id: 'pur_4', reference: 'PO-2026-0138', date: '2026-06-30T00:00:00.000Z',
      supplierInvoiceNumber: 'INV-2201', itemCount: 4, total: 210000, received: 210000, balance: 0,
      status: 'RECEIVED',
    },
  ],
};

const DOCUMENTS: Record<string, SupplierDocument[]> = {
  sup_001: [
    {
      id: 'doc_1', fileName: 'Supply Agreement 2026.pdf', docType: 'AGREEMENT',
      uploadedBy: 'Owner', uploadedAt: '2026-01-11T00:00:00.000Z', sizeBytes: 384_000, url: null,
    },
    {
      id: 'doc_2', fileName: 'Cement Price List Q3.xlsx', docType: 'PRICE_LIST',
      uploadedBy: 'Purchasing', uploadedAt: '2026-07-01T00:00:00.000Z', sizeBytes: 52_000, url: null,
    },
  ],
};

const NOTES: Record<string, SupplierNote[]> = {
  sup_001: [
    {
      id: 'note_1', body: 'Reliable on bulk cement. Confirm delivery a day ahead for large orders.',
      author: 'Purchasing', createdAt: '2026-07-10T00:00:00.000Z', pinned: true,
    },
    {
      id: 'note_2', body: 'Negotiated 3% early-settlement discount from June.',
      author: 'Owner', createdAt: '2026-06-02T00:00:00.000Z', pinned: false,
    },
  ],
  sup_004: [
    {
      id: 'note_3', body: 'Follow up on overdue invoice INV-91002.',
      author: 'Accountant', createdAt: '2026-07-14T00:00:00.000Z', pinned: true,
    },
  ],
};

const PURCHASE_POINTS: Record<string, SupplierPurchasePoint[]> = {
  sup_001: [
    { month: '2026-02', value: 320000 },
    { month: '2026-03', value: 410000 },
    { month: '2026-04', value: 285000 },
    { month: '2026-05', value: 520000 },
    { month: '2026-06', value: 632000 },
    { month: '2026-07', value: 245000 },
  ],
  sup_002: [
    { month: '2026-03', value: 120000 },
    { month: '2026-04', value: 180000 },
    { month: '2026-05', value: 150000 },
    { month: '2026-06', value: 210000 },
  ],
};

/** QuickBooks vendors available to map against (demo). */
export const MOCK_QB_VENDORS: { id: string; name: string; balance: number }[] = [
  { id: 'qbv_58', name: 'Ceylon Cement & Building', balance: 845000 },
  { id: 'qbv_71', name: 'Lanka Paints', balance: 210000 },
  { id: 'qbv_90', name: 'Metro Plumbing', balance: 96000 },
  { id: 'qbv_44', name: 'Apex Tools', balance: 55000 },
  { id: 'qbv_33', name: 'Northern Steel', balance: 0 },
  { id: 'qbv_12', name: 'Highway Electrical Supplies', balance: 0 },
  { id: 'qbv_21', name: 'SafeGuard Ind.', balance: 0 },
];

export const MOCK_RELATED = {
  contacts: CONTACTS,
  products: PRODUCTS,
  purchases: PURCHASES,
  documents: DOCUMENTS,
  notes: NOTES,
  purchasePoints: PURCHASE_POINTS,
};

export const MOCK_CATEGORIES = Object.values(CATS);
