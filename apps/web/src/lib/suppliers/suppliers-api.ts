/**
 * Supplier (QuickBooks Vendor) — typed service adapter. The ONLY module that
 * talks to the network for suppliers; it targets the backend vendor REST
 * surface (`/suppliers`, `/suppliers/import/*`, `/quickbooks/vendors`).
 */

import { api } from './../api';
import type { Session } from './../auth';
import type {
  ImportCommitSummary,
  ParsedSupplierRow,
  QbVendorOption,
  Supplier,
  SupplierInput,
  SuppliersPage,
  SuppliersQuery,
} from './types';

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/v1';

function auth(session: Session) {
  return { token: session.token, tenantId: session.user.tenantId };
}

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

function buildQuery(q: SuppliersQuery): string {
  const params = new URLSearchParams();
  params.set('page', String(q.page ?? 1));
  params.set('pageSize', String(q.pageSize ?? 20));
  if (q.search) params.set('search', q.search);
  if (q.isActive !== undefined) params.set('isActive', q.isActive);
  if (q.qbStatus) params.set('qbStatus', q.qbStatus);
  if (q.sort) params.set('sort', q.sort);
  return params.toString();
}

// ── CRUD ─────────────────────────────────────────────────────────────────────

export async function fetchSuppliers(
  session: Session,
  query: SuppliersQuery = {},
): Promise<SuppliersPage> {
  return api.get<SuppliersPage>(`/suppliers?${buildQuery(query)}`, auth(session));
}

export async function fetchSupplier(session: Session, id: string): Promise<Supplier> {
  return api.get<Supplier>(`/suppliers/${id}`, auth(session));
}

export async function createSupplier(session: Session, input: SupplierInput): Promise<Supplier> {
  return api.post<Supplier>('/suppliers', input, auth(session));
}

export async function updateSupplier(
  session: Session,
  id: string,
  input: Partial<SupplierInput>,
): Promise<Supplier> {
  return api.patch<Supplier>(`/suppliers/${id}`, input, auth(session));
}

export async function deleteSupplier(session: Session, id: string): Promise<void> {
  await api.del<void>(`/suppliers/${id}`, auth(session));
}

// ── QuickBooks vendor mapping ────────────────────────────────────────────────

export async function fetchQbVendors(session: Session, term = ''): Promise<QbVendorOption[]> {
  return api.get<QbVendorOption[]>(
    `/quickbooks/vendors?search=${encodeURIComponent(term)}`,
    auth(session),
  );
}

export async function mapQbVendor(session: Session, id: string, vendorId: string): Promise<Supplier> {
  return api.post<Supplier>(`/suppliers/${id}/quickbooks-mapping`, { vendorId }, auth(session));
}

export async function unmapQbVendor(session: Session, id: string): Promise<Supplier> {
  return api.del<Supplier>(`/suppliers/${id}/quickbooks-mapping`, auth(session));
}

// ── Bulk import (two-phase: preview → review → commit) ──────────────────────

export async function downloadVendorTemplate(session: Session): Promise<void> {
  const res = await authorizedFetch('/suppliers/import/template', session);
  if (!res.ok) throw new Error('Could not download the template');
  saveBlob(await res.blob(), 'vendor-import-template.xlsx');
}

/** Upload a sheet and get back the parsed rows to review (no vendors created). */
export async function previewSupplierImport(
  session: Session,
  file: File,
): Promise<ParsedSupplierRow[]> {
  const form = new FormData();
  form.append('file', file);
  const res = await authorizedFetch('/suppliers/import/preview', session, {
    method: 'POST',
    body: form,
  });
  const json = (await res.json().catch(() => null)) as
    | { message?: string | string[]; data?: ParsedSupplierRow[] }
    | ParsedSupplierRow[]
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
export async function commitSupplierImport(
  session: Session,
  rows: ParsedSupplierRow[],
): Promise<ImportCommitSummary> {
  return api.post<ImportCommitSummary>('/suppliers/import/commit', { rows }, auth(session));
}
