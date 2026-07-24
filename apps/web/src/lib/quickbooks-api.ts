import { api } from './api';
import type { Session } from './auth';

export interface SyncProductsSummary {
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  total: number;
}

export interface CustomerSyncSummary {
  created: number;
  linked: number;
  refreshed: number;
  total: number;
}

export interface VendorSyncSummary {
  created: number;
  linked: number;
  refreshed: number;
  flagged: number;
  total: number;
}

/** Everything the combined "Sync with QuickBooks" action reconciles. */
export interface SyncAllSummary {
  products: SyncProductsSummary;
  customers: CustomerSyncSummary;
  vendors: VendorSyncSummary;
}

/** Trigger a QuickBooks product sync via POST /quickbooks/sync-products. */
export async function syncQuickBooksProducts(session: Session): Promise<SyncProductsSummary> {
  return api.post<SyncProductsSummary>('/quickbooks/sync-products', undefined, {
    token: session.token,
    tenantId: session.user.tenantId,
  });
}

/**
 * Full sync: pull the product catalog, then reconcile customer and vendor
 * QuickBooks mappings, via POST /quickbooks/sync.
 */
export async function syncQuickBooksAll(session: Session): Promise<SyncAllSummary> {
  return api.post<SyncAllSummary>('/quickbooks/sync', undefined, {
    token: session.token,
    tenantId: session.user.tenantId,
  });
}
