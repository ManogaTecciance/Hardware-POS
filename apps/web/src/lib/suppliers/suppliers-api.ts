/**
 * Supplier Management — typed service adapter.
 *
 * This is the ONLY module that talks to the network for suppliers. It targets
 * the intended REST surface (`/suppliers`, `/suppliers/:id/contacts`, …). Until
 * the backend supplier module ships, it runs against an isolated development
 * mock (see `mock-data.ts`), gated by `isSupplierMockMode()`. Demo data is
 * clearly labelled in the UI and never mixed silently with live data; with the
 * mock off, production shows safe empty states rather than fabricated numbers.
 *
 * View-model computation (list projection, aggregation) lives in
 * `view-models.ts`; presentational components receive ready-to-render data.
 */

import { fetchCategories, fetchProducts } from '@/lib/products-api';
import { api as httpClient } from './../api';
import type { Session } from './../auth';

import { MOCK_CATEGORIES, MOCK_QB_VENDORS, MOCK_RELATED, MOCK_SUPPLIERS } from './mock-data';
import type {
  Supplier,
  SupplierCategoryRef,
  SupplierContact,
  SupplierContactInput,
  SupplierDeleteDependencies,
  SupplierDocument,
  SupplierInput,
  SupplierNote,
  SupplierProductLink,
  SupplierProductLinkInput,
  SupplierPurchase,
  SupplierPurchasePoint,
  SupplierStatus,
  SupplierSummaryMetrics,
  SuppliersPage,
  SuppliersQuery,
} from './types';
import {
  computePurchaseSummary,
  computeSummaryMetrics,
  querySuppliers,
  type SupplierRow,
} from './view-models';

// ── Mode ─────────────────────────────────────────────────────────────────────

/**
 * True when the isolated development mock backs the module. Defaults to on in
 * development (no backend supplier module yet) and off in production unless
 * `NEXT_PUBLIC_SUPPLIERS_MOCK=true` is set explicitly.
 */
export function isSupplierMockMode(): boolean {
  const flag = process.env.NEXT_PUBLIC_SUPPLIERS_MOCK;
  if (flag === 'true') return true;
  if (flag === 'false') return false;
  return process.env.NODE_ENV !== 'production';
}

/** Whether the UI should show the "Demo data" banner. */
export const isDemoData = isSupplierMockMode;

// ── Product / QuickBooks vendor search view models ──────────────────────────

export interface LinkableProduct {
  id: string;
  name: string;
  sku: string | null;
  costPrice: number | null;
}

export interface QbVendorOption {
  id: string;
  name: string;
  balance: number | null;
}

// ── Mock store (in-memory, mutable within the browser session) ───────────────

const store = {
  suppliers: MOCK_SUPPLIERS.map((s) => structuredClone(s)),
  contacts: structuredClone(MOCK_RELATED.contacts) as Record<string, SupplierContact[]>,
  products: structuredClone(MOCK_RELATED.products) as Record<string, SupplierProductLink[]>,
  purchases: structuredClone(MOCK_RELATED.purchases) as Record<string, SupplierPurchase[]>,
  documents: structuredClone(MOCK_RELATED.documents) as Record<string, SupplierDocument[]>,
  notes: structuredClone(MOCK_RELATED.notes) as Record<string, SupplierNote[]>,
  points: structuredClone(MOCK_RELATED.purchasePoints) as Record<string, SupplierPurchasePoint[]>,
};

function nowIso(): string {
  return new Date().toISOString();
}

function genId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}

/** Mask an account number to its last four digits (e.g. `•••• 4321`). */
function maskAccount(raw: string | null | undefined): string | null {
  const digits = (raw ?? '').replace(/\s+/g, '');
  if (!digits) return null;
  return `•••• ${digits.slice(-4)}`;
}

function toBankDetails(input: NonNullable<SupplierInput['bank']>): Supplier['bank'] {
  const hasAny =
    input.bankName || input.accountHolder || input.accountNumber || input.branch || input.preferredPaymentMethod;
  if (!hasAny) return null;
  return {
    bankName: input.bankName ?? null,
    accountHolder: input.accountHolder ?? null,
    accountNumberMasked: maskAccount(input.accountNumber),
    branch: input.branch ?? null,
    preferredPaymentMethod: input.preferredPaymentMethod ?? null,
  };
}

/** Small delay so loading skeletons are visible with the instant mock. */
function settle<T>(value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), 120));
}

function rowsFor(suppliers: Supplier[]): SupplierRow[] {
  return suppliers.map((s) => ({
    supplier: s,
    rel: computePurchaseSummary(store.purchases[s.id] ?? []),
  }));
}

function requireSupplier(id: string): Supplier {
  const s = store.suppliers.find((x) => x.id === id);
  if (!s) throw new Error('Supplier not found');
  return s;
}

function auth(session: Session) {
  return { token: session.token, tenantId: session.user.tenantId };
}

// ── Reads ────────────────────────────────────────────────────────────────────

export async function fetchSupplierSummary(session: Session): Promise<SupplierSummaryMetrics> {
  if (!isSupplierMockMode()) {
    return api().get<SupplierSummaryMetrics>('/suppliers/summary', auth(session));
  }
  const month = new Date().toISOString().slice(0, 7);
  return settle(computeSummaryMetrics(rowsFor(store.suppliers), month));
}

export async function fetchSuppliers(
  session: Session,
  query: SuppliersQuery = {},
): Promise<SuppliersPage> {
  if (!isSupplierMockMode()) {
    return api().get<SuppliersPage>(`/suppliers?${buildQuery(query)}`, auth(session));
  }
  return settle(querySuppliers(rowsFor(store.suppliers), query));
}

export async function fetchSupplier(session: Session, id: string): Promise<Supplier> {
  if (!isSupplierMockMode()) {
    return api().get<Supplier>(`/suppliers/${id}`, auth(session));
  }
  return settle(structuredClone(requireSupplier(id)));
}

export async function fetchSupplierCodes(session: Session): Promise<string[]> {
  if (!isSupplierMockMode()) {
    return api().get<string[]>('/suppliers/codes', auth(session));
  }
  return settle(store.suppliers.map((s) => s.code.toLowerCase()));
}

export async function fetchSupplierContacts(session: Session, id: string): Promise<SupplierContact[]> {
  if (!isSupplierMockMode()) {
    return api().get<SupplierContact[]>(`/suppliers/${id}/contacts`, auth(session));
  }
  return settle(structuredClone(store.contacts[id] ?? []));
}

export async function fetchSupplierProducts(session: Session, id: string): Promise<SupplierProductLink[]> {
  if (!isSupplierMockMode()) {
    return api().get<SupplierProductLink[]>(`/suppliers/${id}/products`, auth(session));
  }
  return settle(structuredClone(store.products[id] ?? []));
}

export async function fetchSupplierPurchases(session: Session, id: string): Promise<SupplierPurchase[]> {
  if (!isSupplierMockMode()) {
    return api().get<SupplierPurchase[]>(`/suppliers/${id}/purchases`, auth(session));
  }
  return settle(structuredClone(store.purchases[id] ?? []));
}

export async function fetchSupplierDocuments(session: Session, id: string): Promise<SupplierDocument[]> {
  if (!isSupplierMockMode()) {
    return api().get<SupplierDocument[]>(`/suppliers/${id}/documents`, auth(session));
  }
  return settle(structuredClone(store.documents[id] ?? []));
}

export async function fetchSupplierNotes(session: Session, id: string): Promise<SupplierNote[]> {
  if (!isSupplierMockMode()) {
    return api().get<SupplierNote[]>(`/suppliers/${id}/notes`, auth(session));
  }
  return settle(structuredClone(store.notes[id] ?? []));
}

export async function fetchSupplierPurchasePoints(
  session: Session,
  id: string,
): Promise<SupplierPurchasePoint[]> {
  if (!isSupplierMockMode()) {
    return api().get<SupplierPurchasePoint[]>(`/suppliers/${id}/purchase-activity`, auth(session));
  }
  return settle(structuredClone(store.points[id] ?? []));
}

export async function fetchSupplierDeleteDependencies(
  session: Session,
  id: string,
): Promise<SupplierDeleteDependencies> {
  if (!isSupplierMockMode()) {
    return api().get<SupplierDeleteDependencies>(`/suppliers/${id}/delete-check`, auth(session));
  }
  const s = requireSupplier(id);
  return settle<SupplierDeleteDependencies>({
    purchaseCount: (store.purchases[id] ?? []).length,
    purchaseOrderCount: (store.purchases[id] ?? []).length,
    linkedProductCount: (store.products[id] ?? []).length,
    documentCount: (store.documents[id] ?? []).length,
    hasQuickBooksMapping: s.quickbooks.status !== 'NOT_CONNECTED',
    hasFinancialRecords: s.financials.available,
    hasAuditDependencies: false,
  });
}

// ── Category & product search (reuse existing services) ──────────────────────

export async function fetchSupplierCategories(session: Session): Promise<SupplierCategoryRef[]> {
  if (!isSupplierMockMode()) {
    const cats = await fetchCategories(session);
    return cats.map((c) => ({ id: c.id, name: c.name }));
  }
  return settle(structuredClone(MOCK_CATEGORIES));
}

export async function searchLinkableProducts(
  session: Session,
  term: string,
): Promise<LinkableProduct[]> {
  const res = await fetchProducts(session, { search: term || undefined, pageSize: 20, isActive: 'true' });
  return res.items.map((p) => ({ id: p.id, name: p.name, sku: p.sku, costPrice: p.costPrice }));
}

export async function fetchQbVendors(session: Session, term = ''): Promise<QbVendorOption[]> {
  if (!isSupplierMockMode()) {
    return api().get<QbVendorOption[]>(`/quickbooks/vendors?search=${encodeURIComponent(term)}`, auth(session));
  }
  const t = term.trim().toLowerCase();
  const vendors = MOCK_QB_VENDORS.filter((v) => !t || v.name.toLowerCase().includes(t));
  return settle(vendors.map((v) => ({ id: v.id, name: v.name, balance: v.balance })));
}

// ── Mutations ────────────────────────────────────────────────────────────────

export async function createSupplier(session: Session, input: SupplierInput): Promise<Supplier> {
  if (!isSupplierMockMode()) {
    return api().post<Supplier>('/suppliers', input, auth(session));
  }
  const now = nowIso();
  const created: Supplier = {
    id: genId('sup'),
    name: input.name,
    code: input.code?.trim() || `SUP-${store.suppliers.length + 1}`,
    status: input.status,
    isPreferred: input.isPreferred,
    logoUrl: null,
    mainContactName: input.mainContactName ?? null,
    phone: input.phone ?? null,
    whatsapp: input.whatsapp ?? null,
    email: input.email ?? null,
    address: input.address ?? null,
    city: input.city ?? null,
    country: input.country ?? 'Sri Lanka',
    legalName: input.legalName ?? null,
    registrationNumber: input.registrationNumber ?? null,
    vatNumber: input.vatNumber ?? null,
    website: input.website ?? null,
    defaultCurrency: input.defaultCurrency ?? 'LKR',
    paymentTerms: input.paymentTerms ?? null,
    creditLimit: input.creditLimit ?? null,
    defaultLeadTimeDays: input.defaultLeadTimeDays ?? null,
    minOrderValue: input.minOrderValue ?? null,
    categories: (input.categoryIds ?? [])
      .map((id) => MOCK_CATEGORIES.find((c) => c.id === id))
      .filter((c): c is SupplierCategoryRef => !!c),
    internalNotes: input.internalNotes ?? null,
    preferredCommunication: input.preferredCommunication ?? 'PHONE',
    bank: input.bank ? toBankDetails(input.bank) : null,
    blockedReason: null,
    quickbooks: {
      status: 'NOT_CONNECTED', quickbooksVendorId: null, quickbooksVendorName: null,
      lastSyncedAt: null, suggestedVendorId: null, suggestedVendorName: null,
      matchConfidence: null, message: null,
    },
    financials: {
      available: false, quickbooksVendorName: null, outstandingBalance: null, overdueBalance: null,
      openBills: null, lastPaymentAt: null, lastPaymentAmount: null, totalPurchased: null,
      paymentTerms: null, lastSyncedAt: null, quickbooksUrl: null,
    },
    createdAt: now,
    updatedAt: now,
  };
  store.suppliers.unshift(created);
  return settle(structuredClone(created));
}

export async function updateSupplier(
  session: Session,
  id: string,
  input: SupplierInput,
): Promise<Supplier> {
  if (!isSupplierMockMode()) {
    return api().patch<Supplier>(`/suppliers/${id}`, input, auth(session));
  }
  const s = requireSupplier(id);
  Object.assign(s, {
    name: input.name,
    code: input.code?.trim() || s.code,
    status: input.status,
    isPreferred: input.isPreferred,
    mainContactName: input.mainContactName ?? null,
    phone: input.phone ?? null,
    whatsapp: input.whatsapp ?? null,
    email: input.email ?? null,
    address: input.address ?? null,
    city: input.city ?? null,
    country: input.country ?? s.country,
    legalName: input.legalName ?? null,
    registrationNumber: input.registrationNumber ?? null,
    vatNumber: input.vatNumber ?? null,
    website: input.website ?? null,
    defaultCurrency: input.defaultCurrency ?? s.defaultCurrency,
    paymentTerms: input.paymentTerms ?? null,
    creditLimit: input.creditLimit ?? null,
    defaultLeadTimeDays: input.defaultLeadTimeDays ?? null,
    minOrderValue: input.minOrderValue ?? null,
    categories: (input.categoryIds ?? s.categories.map((c) => c.id))
      .map((cid) => MOCK_CATEGORIES.find((c) => c.id === cid) ?? s.categories.find((c) => c.id === cid))
      .filter((c): c is SupplierCategoryRef => !!c),
    internalNotes: input.internalNotes ?? null,
    preferredCommunication: input.preferredCommunication ?? s.preferredCommunication,
    bank: input.bank !== undefined ? (input.bank ? toBankDetails(input.bank) : null) : s.bank,
    updatedAt: nowIso(),
  } satisfies Partial<Supplier>);
  return settle(structuredClone(s));
}

export async function setSupplierStatus(
  session: Session,
  id: string,
  status: SupplierStatus,
  reason?: string,
): Promise<Supplier> {
  if (!isSupplierMockMode()) {
    return api().post<Supplier>(`/suppliers/${id}/status`, { status, reason }, auth(session));
  }
  const s = requireSupplier(id);
  s.status = status;
  s.blockedReason = status === 'BLOCKED' ? reason ?? s.blockedReason ?? 'Blocked' : null;
  s.updatedAt = nowIso();
  return settle(structuredClone(s));
}

export async function deleteSupplier(session: Session, id: string): Promise<void> {
  if (!isSupplierMockMode()) {
    await api().del<void>(`/suppliers/${id}`, auth(session));
    return;
  }
  const idx = store.suppliers.findIndex((x) => x.id === id);
  if (idx >= 0) store.suppliers.splice(idx, 1);
  await settle(undefined);
}

// Contacts ---------------------------------------------------------------------

export async function addSupplierContact(
  session: Session,
  id: string,
  input: SupplierContactInput,
): Promise<SupplierContact> {
  if (!isSupplierMockMode()) {
    return api().post<SupplierContact>(`/suppliers/${id}/contacts`, input, auth(session));
  }
  const list = (store.contacts[id] ??= []);
  if (input.isPrimary) list.forEach((c) => (c.isPrimary = false));
  const contact: SupplierContact = { id: genId('con'), ...normalizeContact(input) };
  list.push(contact);
  syncMainContact(id);
  return settle(structuredClone(contact));
}

export async function updateSupplierContact(
  session: Session,
  id: string,
  contactId: string,
  input: SupplierContactInput,
): Promise<SupplierContact> {
  if (!isSupplierMockMode()) {
    return api().patch<SupplierContact>(`/suppliers/${id}/contacts/${contactId}`, input, auth(session));
  }
  const list = store.contacts[id] ?? [];
  const contact = list.find((c) => c.id === contactId);
  if (!contact) throw new Error('Contact not found');
  if (input.isPrimary) list.forEach((c) => (c.isPrimary = false));
  Object.assign(contact, normalizeContact(input));
  syncMainContact(id);
  return settle(structuredClone(contact));
}

/** Normalise optional contact fields to explicit nulls. */
function normalizeContact(input: SupplierContactInput): Omit<SupplierContact, 'id'> {
  return {
    fullName: input.fullName,
    jobTitle: input.jobTitle ?? null,
    contactType: input.contactType,
    phone: input.phone ?? null,
    whatsapp: input.whatsapp ?? null,
    email: input.email ?? null,
    preferredMethod: input.preferredMethod,
    isPrimary: input.isPrimary,
    isActive: input.isActive,
  };
}

export async function setPrimaryContact(
  session: Session,
  id: string,
  contactId: string,
): Promise<SupplierContact[]> {
  if (!isSupplierMockMode()) {
    return api().post<SupplierContact[]>(`/suppliers/${id}/contacts/${contactId}/primary`, undefined, auth(session));
  }
  const list = store.contacts[id] ?? [];
  list.forEach((c) => (c.isPrimary = c.id === contactId));
  syncMainContact(id);
  return settle(structuredClone(list));
}

export async function deleteSupplierContact(
  session: Session,
  id: string,
  contactId: string,
): Promise<void> {
  if (!isSupplierMockMode()) {
    await api().del<void>(`/suppliers/${id}/contacts/${contactId}`, auth(session));
    return;
  }
  const list = store.contacts[id] ?? [];
  const idx = list.findIndex((c) => c.id === contactId);
  if (idx >= 0) list.splice(idx, 1);
  syncMainContact(id);
  await settle(undefined);
}

/** Keep the supplier's denormalised main-contact fields in step with contacts. */
function syncMainContact(id: string): void {
  const supplier = store.suppliers.find((s) => s.id === id);
  if (!supplier) return;
  const primary = (store.contacts[id] ?? []).find((c) => c.isPrimary && c.isActive);
  if (primary) {
    supplier.mainContactName = primary.fullName;
    supplier.phone = primary.phone ?? supplier.phone;
    supplier.email = primary.email ?? supplier.email;
  }
}

// Product links ----------------------------------------------------------------

export async function linkSupplierProducts(
  session: Session,
  id: string,
  inputs: SupplierProductLinkInput[],
  productLookup: LinkableProduct[],
): Promise<SupplierProductLink[]> {
  if (!isSupplierMockMode()) {
    return api().post<SupplierProductLink[]>(`/suppliers/${id}/products`, { links: inputs }, auth(session));
  }
  const list = (store.products[id] ??= []);
  for (const input of inputs) {
    const meta = productLookup.find((p) => p.id === input.productId);
    list.push({
      id: genId('spl'),
      productId: input.productId,
      productName: meta?.name ?? input.productId,
      productSku: meta?.sku ?? null,
      supplierSku: input.supplierSku ?? null,
      currentCost: input.currentCost ?? meta?.costPrice ?? null,
      lastCost: null,
      minOrderQty: input.minOrderQty ?? null,
      leadTimeDays: input.leadTimeDays ?? null,
      lastPurchasedAt: null,
      isPreferredSupplier: input.isPreferredSupplier ?? false,
      isActive: true,
    });
  }
  return settle(structuredClone(list));
}

export async function updateSupplierProductLink(
  session: Session,
  id: string,
  linkId: string,
  patch: Partial<SupplierProductLink>,
): Promise<SupplierProductLink> {
  if (!isSupplierMockMode()) {
    return api().patch<SupplierProductLink>(`/suppliers/${id}/products/${linkId}`, patch, auth(session));
  }
  const link = (store.products[id] ?? []).find((p) => p.id === linkId);
  if (!link) throw new Error('Product link not found');
  Object.assign(link, patch);
  return settle(structuredClone(link));
}

export async function unlinkSupplierProduct(
  session: Session,
  id: string,
  linkId: string,
): Promise<void> {
  if (!isSupplierMockMode()) {
    await api().del<void>(`/suppliers/${id}/products/${linkId}`, auth(session));
    return;
  }
  const list = store.products[id] ?? [];
  const idx = list.findIndex((p) => p.id === linkId);
  if (idx >= 0) list.splice(idx, 1);
  await settle(undefined);
}

// Notes ------------------------------------------------------------------------

export async function addSupplierNote(
  session: Session,
  id: string,
  body: string,
): Promise<SupplierNote> {
  if (!isSupplierMockMode()) {
    return api().post<SupplierNote>(`/suppliers/${id}/notes`, { body }, auth(session));
  }
  const list = (store.notes[id] ??= []);
  const note: SupplierNote = {
    id: genId('note'),
    body,
    author: session.user.name ?? 'You',
    createdAt: nowIso(),
    pinned: false,
  };
  list.unshift(note);
  return settle(structuredClone(note));
}

export async function updateSupplierNote(
  session: Session,
  id: string,
  noteId: string,
  patch: { body?: string; pinned?: boolean },
): Promise<SupplierNote> {
  if (!isSupplierMockMode()) {
    return api().patch<SupplierNote>(`/suppliers/${id}/notes/${noteId}`, patch, auth(session));
  }
  const note = (store.notes[id] ?? []).find((n) => n.id === noteId);
  if (!note) throw new Error('Note not found');
  Object.assign(note, patch);
  return settle(structuredClone(note));
}

export async function deleteSupplierNote(
  session: Session,
  id: string,
  noteId: string,
): Promise<void> {
  if (!isSupplierMockMode()) {
    await api().del<void>(`/suppliers/${id}/notes/${noteId}`, auth(session));
    return;
  }
  const list = store.notes[id] ?? [];
  const idx = list.findIndex((n) => n.id === noteId);
  if (idx >= 0) list.splice(idx, 1);
  await settle(undefined);
}

// Documents --------------------------------------------------------------------

export async function uploadSupplierDocument(
  session: Session,
  id: string,
  file: { name: string; size: number; docType: SupplierDocument['docType'] },
): Promise<SupplierDocument> {
  if (!isSupplierMockMode()) {
    // Real: multipart upload to the existing storage infrastructure.
    return api().post<SupplierDocument>(`/suppliers/${id}/documents`, file, auth(session));
  }
  const list = (store.documents[id] ??= []);
  const doc: SupplierDocument = {
    id: genId('doc'),
    fileName: file.name,
    docType: file.docType,
    uploadedBy: session.user.name ?? 'You',
    uploadedAt: nowIso(),
    sizeBytes: file.size,
    url: null,
  };
  list.unshift(doc);
  return settle(structuredClone(doc));
}

export async function deleteSupplierDocument(
  session: Session,
  id: string,
  docId: string,
): Promise<void> {
  if (!isSupplierMockMode()) {
    await api().del<void>(`/suppliers/${id}/documents/${docId}`, auth(session));
    return;
  }
  const list = store.documents[id] ?? [];
  const idx = list.findIndex((d) => d.id === docId);
  if (idx >= 0) list.splice(idx, 1);
  await settle(undefined);
}

// QuickBooks mapping -----------------------------------------------------------

export async function mapQbVendor(
  session: Session,
  id: string,
  vendorId: string,
  vendorName: string,
): Promise<Supplier> {
  if (!isSupplierMockMode()) {
    return api().post<Supplier>(`/suppliers/${id}/quickbooks-mapping`, { vendorId }, auth(session));
  }
  const s = requireSupplier(id);
  s.quickbooks = {
    status: 'CONNECTED',
    quickbooksVendorId: vendorId,
    quickbooksVendorName: vendorName,
    lastSyncedAt: nowIso(),
    suggestedVendorId: null,
    suggestedVendorName: null,
    matchConfidence: null,
    message: null,
  };
  const vendor = MOCK_QB_VENDORS.find((v) => v.id === vendorId);
  s.financials = {
    ...s.financials,
    available: true,
    quickbooksVendorName: vendorName,
    outstandingBalance: vendor?.balance ?? 0,
    overdueBalance: s.financials.overdueBalance ?? 0,
    openBills: s.financials.openBills ?? 0,
    lastSyncedAt: nowIso(),
    quickbooksUrl: 'https://qbo.intuit.com/app/vendordetail',
  };
  s.updatedAt = nowIso();
  return settle(structuredClone(s));
}

export async function unmapQbVendor(session: Session, id: string): Promise<Supplier> {
  if (!isSupplierMockMode()) {
    return api().del<Supplier>(`/suppliers/${id}/quickbooks-mapping`, auth(session));
  }
  const s = requireSupplier(id);
  s.quickbooks = {
    status: 'NOT_CONNECTED', quickbooksVendorId: null, quickbooksVendorName: null,
    lastSyncedAt: null, suggestedVendorId: null, suggestedVendorName: null,
    matchConfidence: null, message: null,
  };
  s.updatedAt = nowIso();
  return settle(structuredClone(s));
}

// ── Network helpers (used only when the backend module is available) ─────────

function buildQuery(q: SuppliersQuery): string {
  const params = new URLSearchParams();
  params.set('page', String(q.page ?? 1));
  params.set('pageSize', String(q.pageSize ?? 20));
  if (q.search) params.set('search', q.search);
  if (q.status) params.set('status', q.status);
  if (q.preferred) params.set('preferred', 'true');
  if (q.hasOutstanding) params.set('hasOutstanding', 'true');
  if (q.overdue) params.set('overdue', 'true');
  if (q.pendingActivity) params.set('pendingActivity', 'true');
  if (q.qbStatus) params.set('qbStatus', q.qbStatus);
  if (q.categoryId) params.set('categoryId', q.categoryId);
  if (q.sort) params.set('sort', q.sort);
  return params.toString();
}

/** The shared HTTP client, used only on the live-backend branch. */
function api() {
  return httpClient;
}
