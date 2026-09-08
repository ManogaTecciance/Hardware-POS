/**
 * D125 Part 3 — the barcode audit and reissue pass (Phase 5, `5.9`), and label
 * printing (`5.7`).
 *
 * Required fields throughout, for the `4.15` / `4.21` reason: a wire field that
 * an optional type lets a mapper drop is a blank on a screen with no compile
 * error. The wire types below are the ONLY place optionality belongs, and there
 * is no separate wire type here because the server always sends every field.
 */

import { api } from '../api';
import type { Session } from '../auth';

export type BarcodeVerdict = 'VALID_EAN13' | 'INVALID_CHECK_DIGIT' | 'NOT_EAN13';
export type BarcodeSource = 'SUPPLIER' | 'INTERNAL';

export interface BarcodeAuditRow {
  variantId: string;
  productId: string;
  productName: string;
  sku: string;
  barcode: string;
  verdict: BarcodeVerdict;
  source: BarcodeSource | null;
}

export interface BarcodeAuditReport {
  scanned: number;
  withBarcode: number;
  valid: number;
  invalidCheckDigit: number;
  notEan13: number;
  /** Only rows needing attention. A clean catalogue reports an empty list. */
  problems: BarcodeAuditRow[];
}

export interface LabelRequest {
  variantId: string;
  quantity: number;
}

export interface LabelSheet {
  html: string;
  labelCount: number;
  /** Never silently dropped — each carries the reason it could not be drawn. */
  skipped: Array<{ variantId: string; sku: string; reason: string }>;
}

export interface QueuedLabels {
  printJobId: string;
  labelCount: number;
  skipped: LabelSheet['skipped'];
}

function auth(session: Session) {
  return { token: session.token, tenantId: session.user.tenantId };
}

export function fetchBarcodeAudit(session: Session): Promise<BarcodeAuditReport> {
  return api.get<BarcodeAuditReport>('/barcodes/audit', auth(session));
}

/**
 * Reissue the named variants only.
 *
 * There is deliberately no "reissue everything invalid" call on the server, so
 * there is none here either — this rewrites identifiers that may already be
 * printed on something.
 */
export function reissueBarcodes(
  session: Session,
  variantIds: string[],
): Promise<{ reissued: BarcodeAuditRow[] }> {
  return api.post<{ reissued: BarcodeAuditRow[] }>(
    '/barcodes/reissue',
    { variantIds },
    auth(session),
  );
}

export function previewLabels(session: Session, labels: LabelRequest[]): Promise<LabelSheet> {
  return api.post<LabelSheet>('/labels/preview', { labels }, auth(session));
}

export function printLabels(
  session: Session,
  labels: LabelRequest[],
  copies: number,
): Promise<QueuedLabels> {
  return api.post<QueuedLabels>('/labels/print', { labels, copies }, auth(session));
}
