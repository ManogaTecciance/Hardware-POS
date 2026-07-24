import { api } from './api';
import type { Session } from './auth';

export type CustomerType = 'WALK_IN' | 'RETAIL' | 'CONTRACTOR' | 'CREDIT' | 'DEALER';
export type CustomerSyncStatus = 'NOT_SYNCED' | 'PENDING' | 'SYNCING' | 'SYNCED' | 'FAILED';

export const CUSTOMER_TYPE_LABELS: Record<CustomerType, string> = {
  WALK_IN: 'Walk-in',
  RETAIL: 'Retail',
  CONTRACTOR: 'Contractor',
  CREDIT: 'Credit customer',
  DEALER: 'Dealer',
};

/**
 * A customer mirrors the QuickBooks Online Customer record (the customer
 * import template's columns) plus POS payment controls (operational type +
 * credit) and system fields. QuickBooks owns customer financials; only the
 * entered opening balance is stored here.
 */
export interface ManagedCustomer {
  id: string;
  name: string;
  company: string | null;
  /** QuickBooks' free-text customer type taxonomy (e.g. "Wholesale Trade"). */
  qbCustomerType: string | null;
  email: string | null;
  phone: string | null;
  mobile: string | null;
  fax: string | null;
  website: string | null;
  street: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  country: string | null;
  openingBalance: number | null;
  openingBalanceDate: string | null;
  resaleNumber: string | null;
  // POS payment controls
  customerType: CustomerType;
  creditAllowed: boolean;
  creditLimit: number | null;
  // System
  isActive: boolean;
  quickbooksCustomerId: string | null;
  syncStatus: CustomerSyncStatus;
}

export interface CustomersPage {
  items: ManagedCustomer[];
  total: number;
  page: number;
  pageSize: number;
}

export interface CustomersQuery {
  page?: number;
  pageSize?: number;
  search?: string;
  customerType?: CustomerType;
  isActive?: 'true' | 'false';
}

export interface CustomerInput {
  name: string;
  company?: string | null;
  qbCustomerType?: string | null;
  email?: string | null;
  phone?: string | null;
  mobile?: string | null;
  fax?: string | null;
  website?: string | null;
  street?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  country?: string | null;
  openingBalance?: number | null;
  openingBalanceDate?: string | null;
  resaleNumber?: string | null;
  customerType?: CustomerType;
  creditAllowed?: boolean;
  creditLimit?: number | null;
  isActive?: boolean;
}

/** Raw JSON — Prisma Decimals may arrive as strings. */
type ApiCustomer = Omit<ManagedCustomer, 'creditLimit' | 'openingBalance'> & {
  creditLimit: string | number | null;
  openingBalance: string | number | null;
};

function auth(session: Session): { token: string; tenantId: string } {
  return { token: session.token, tenantId: session.user.tenantId };
}

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/v1';

function authorizedFetch(path: string, session: Session, init?: RequestInit): Promise<Response> {
  return fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${session.token}`,
      'X-Tenant-Id': session.user.tenantId,
      ...(init?.headers ?? {}),
    },
  });
}

function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function toManaged(c: ApiCustomer): ManagedCustomer {
  return {
    ...c,
    creditLimit: c.creditLimit != null ? Number(c.creditLimit) : null,
    openingBalance: c.openingBalance != null ? Number(c.openingBalance) : null,
  };
}

function buildQuery(q: CustomersQuery): string {
  const params = new URLSearchParams();
  params.set('page', String(q.page ?? 1));
  params.set('pageSize', String(q.pageSize ?? 25));
  if (q.search) params.set('search', q.search);
  if (q.customerType) params.set('customerType', q.customerType);
  if (q.isActive) params.set('isActive', q.isActive);
  return params.toString();
}

export async function fetchCustomers(
  session: Session,
  query: CustomersQuery = {},
): Promise<CustomersPage> {
  const res = await api.get<{ items: ApiCustomer[]; total: number; page: number; pageSize: number }>(
    `/customers?${buildQuery(query)}`,
    auth(session),
  );
  return { ...res, items: res.items.map(toManaged) };
}

export async function fetchCustomer(session: Session, id: string): Promise<ManagedCustomer> {
  return toManaged(await api.get<ApiCustomer>(`/customers/${id}`, auth(session)));
}

export async function createCustomer(
  session: Session,
  input: CustomerInput,
): Promise<ManagedCustomer> {
  return toManaged(await api.post<ApiCustomer>('/customers', input, auth(session)));
}

export async function updateCustomer(
  session: Session,
  id: string,
  input: Partial<CustomerInput>,
): Promise<ManagedCustomer> {
  return toManaged(await api.patch<ApiCustomer>(`/customers/${id}`, input, auth(session)));
}

export async function syncCustomerToQuickBooks(
  session: Session,
  id: string,
): Promise<ManagedCustomer> {
  return toManaged(
    await api.post<ApiCustomer>(`/customers/${id}/sync-to-quickbooks`, undefined, auth(session)),
  );
}

// ── Bulk import (two-phase: preview → review → commit) ──────────────────────

export interface ParsedCustomerRow {
  rowNumber: number;
  name: string;
  company: string | null;
  qbCustomerType: string | null;
  email: string | null;
  phone: string | null;
  mobile: string | null;
  fax: string | null;
  website: string | null;
  street: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  country: string | null;
  openingBalance: number | null;
  openingBalanceDate: string | null;
  resaleNumber: string | null;
  matchStatus: 'create' | 'update';
  errors: string[];
}

export interface CustomerImportCommitResult {
  rowNumber: number;
  customerId: string | null;
  outcome: 'created' | 'updated' | 'failed';
  error?: string;
}

export interface CustomerImportCommitSummary {
  created: number;
  updated: number;
  failed: number;
  results: CustomerImportCommitResult[];
}

export async function downloadCustomerTemplate(session: Session): Promise<void> {
  const res = await authorizedFetch('/customers/import/template', session);
  if (!res.ok) throw new Error('Could not download the template');
  saveBlob(await res.blob(), 'customer-import-template.xlsx');
}

/** Upload a sheet and get back the parsed rows to review (no customers created). */
export async function previewCustomerImport(
  session: Session,
  file: File,
): Promise<ParsedCustomerRow[]> {
  const form = new FormData();
  form.append('file', file);
  const res = await authorizedFetch('/customers/import/preview', session, {
    method: 'POST',
    body: form,
  });
  const json = (await res.json().catch(() => null)) as
    | { message?: string | string[]; data?: ParsedCustomerRow[] }
    | ParsedCustomerRow[]
    | null;
  if (!res.ok) {
    const message =
      (json && !Array.isArray(json) && json.message) ||
      (res.status === 413 ? 'File is too large (max 10MB)' : 'Could not read file');
    throw new Error(Array.isArray(message) ? message.join(', ') : message);
  }
  if (Array.isArray(json)) return json;
  return json?.data ?? [];
}

/** Commit the reviewed rows. */
export async function commitCustomerImport(
  session: Session,
  rows: ParsedCustomerRow[],
): Promise<CustomerImportCommitSummary> {
  return api.post<CustomerImportCommitSummary>('/customers/import/commit', { rows }, auth(session));
}
