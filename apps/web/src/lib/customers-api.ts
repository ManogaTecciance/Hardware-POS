import { api } from './api';
import type { PaymentMethodCode } from './sales';
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
  /** List responses only: unpaid balance across this customer's unsettled sales. */
  outstandingCredit?: number;
  /** List responses only: credit limit less what is owed. Null when no limit is set. */
  availableCredit?: number | null;
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
  /** Only customers who currently owe money — the dashboard receivables card links here. */
  hasOutstandingCredit?: 'true';
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
type ApiCustomer = Omit<
  ManagedCustomer,
  'creditLimit' | 'openingBalance' | 'outstandingCredit' | 'availableCredit'
> & {
  creditLimit: string | number | null;
  openingBalance: string | number | null;
  outstandingCredit?: string | number | null;
  availableCredit?: string | number | null;
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
    outstandingCredit: c.outstandingCredit != null ? Number(c.outstandingCredit) : undefined,
    // Null is meaningful here — "no limit set" — so it must survive the coercion
    // rather than collapsing into undefined alongside "the detail endpoint does
    // not send this field at all".
    availableCredit:
      c.availableCredit === undefined ? undefined : c.availableCredit === null ? null : Number(c.availableCredit),
  };
}

function buildQuery(q: CustomersQuery): string {
  const params = new URLSearchParams();
  params.set('page', String(q.page ?? 1));
  params.set('pageSize', String(q.pageSize ?? 25));
  if (q.search) params.set('search', q.search);
  if (q.customerType) params.set('customerType', q.customerType);
  if (q.hasOutstandingCredit) params.set('hasOutstandingCredit', q.hasOutstandingCredit);
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

/** A customer's live credit position, as the sale-completion guard sees it. */
export interface CustomerCredit {
  creditAllowed: boolean;
  /** null = no limit configured, which means unlimited — NOT zero. */
  creditLimit: number | null;
  /** Unpaid balance across this customer's completed, unsettled sales. */
  outstanding: number;
  /** `creditLimit - outstanding`, or null when there is no limit. Can be negative. */
  available: number | null;
}

/**
 * Fetch what a customer owes right now.
 *
 * Deliberately not cached in the cart: outstanding moves when any till records a
 * payment or completes another credit sale, so a figure stored alongside the
 * order goes stale exactly when it matters.
 */
export async function fetchCustomerCredit(
  session: Session,
  id: string,
): Promise<CustomerCredit> {
  const c = await api.get<{
    creditAllowed: boolean;
    creditLimit: string | number | null;
    outstanding: string | number;
    available: string | number | null;
  }>(`/customers/${id}/credit`, auth(session));
  return {
    creditAllowed: c.creditAllowed,
    creditLimit: c.creditLimit == null ? null : Number(c.creditLimit),
    outstanding: Number(c.outstanding),
    available: c.available == null ? null : Number(c.available),
  };
}

/** One payment received against a customer's credit account. */
export interface AccountPayment {
  id: string;
  amount: number;
  method: PaymentMethodCode;
  reference: string | null;
  createdAt: string;
  /** When this payment was consumed by clearing the account; null while it is still working. */
  settledAt: string | null;
}

/** A customer's credit history — account payments, newest first. */
export async function fetchCustomerPayments(
  session: Session,
  customerId: string,
): Promise<AccountPayment[]> {
  const rows = await api.get<
    Array<{
      id: string;
      amount: string | number;
      method: PaymentMethodCode;
      reference: string | null;
      createdAt: string;
      settledAt: string | null;
    }>
  >(`/payments?customerId=${encodeURIComponent(customerId)}`, auth(session));
  return rows.map((r) => ({
    id: r.id,
    amount: Number(r.amount),
    method: r.method,
    reference: r.reference,
    createdAt: r.createdAt,
    settledAt: r.settledAt ?? null,
  }));
}

/** What recording an account payment did. */
export interface AccountPaymentResult {
  /** The account balance after this payment. */
  outstanding: number;
  /** How many invoices it cleared — non-zero only when it closed the account. */
  salesSettled: number;
}

/**
 * Record a payment received against a customer's credit account.
 *
 * Not against any one invoice: credit is an account balance, so while anything
 * is still owed every credit sale stays outstanding, and the moment the account
 * reaches zero the invoices it covered are all marked settled together.
 */
export async function recordAccountPayment(
  session: Session,
  payload: {
    customerId: string;
    method: PaymentMethodCode;
    amount: number;
    reference?: string;
  },
): Promise<AccountPaymentResult> {
  const res = await api.post<{ outstanding: string | number; salesSettled: number }>(
    '/payments',
    payload,
    auth(session),
  );
  return { outstanding: Number(res.outstanding), salesSettled: res.salesSettled };
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
