'use client';

import * as React from 'react';

import { api } from './api';
import { useAuth, type Session } from './auth';
import { fetchProducts } from './products-api';
import {
  syncQuickBooksAll,
  syncQuickBooksProducts,
  type SyncAllSummary,
  type SyncProductsSummary,
} from './quickbooks-api';

export type SyncState = 'SYNCED' | 'SYNCING' | 'FAILED' | 'PENDING' | 'NOT_SYNCED';

export interface QbCompany {
  name: string;
  realmId: string;
  environment: string;
  /** ISO currency code configured on the connected QuickBooks company (null while unknown). */
  currency: string | null;
}

export interface QbProduct {
  id: string;
  name: string;
  sku: string | null;
  quickbooksItemId: string;
  unitPrice: number;
  quantityOnHand: number;
  syncStatus: SyncState;
  lastSyncISO: string | null;
}

export type QbLogType =
  | 'PRODUCT_PULL'
  | 'SALE_PUSH'
  | 'RETURN_PUSH'
  | 'CUSTOMER_PULL'
  | 'VENDOR_PULL'
  | 'CONNECTION';

export interface QbLogEntry {
  id: string;
  tsISO: string;
  type: QbLogType;
  direction: 'INBOUND' | 'OUTBOUND';
  status: SyncState;
  message: string;
}

export interface QbState {
  connected: boolean;
  company: QbCompany | null;
  connectedAtISO: string | null;
  lastSyncISO: string | null;
  productSync: { status: SyncState; count: number; lastSyncISO: string | null };
  salesSync: { status: SyncState; pushed: number; lastSyncISO: string | null };
  customerSync: { status: SyncState; linked: number; total: number; lastSyncISO: string | null };
  vendorSync: {
    status: SyncState;
    linked: number;
    total: number;
    attention: number;
    lastSyncISO: string | null;
  };
  errorsCount: number;
  log: QbLogEntry[];
  products: QbProduct[];
}

const DISCONNECTED_STATE: QbState = {
  connected: false,
  company: null,
  connectedAtISO: null,
  lastSyncISO: null,
  productSync: { status: 'NOT_SYNCED', count: 0, lastSyncISO: null },
  salesSync: { status: 'NOT_SYNCED', pushed: 0, lastSyncISO: null },
  customerSync: { status: 'NOT_SYNCED', linked: 0, total: 0, lastSyncISO: null },
  vendorSync: { status: 'NOT_SYNCED', linked: 0, total: 0, attention: 0, lastSyncISO: null },
  errorsCount: 0,
  log: [],
  products: [],
};

/** Customer / vendor mapping counts from GET /quickbooks/party-sync-status. */
interface PartySyncStatus {
  customers: { linked: number; total: number; lastSyncedAt: string | null };
  vendors: { linked: number; total: number; attention: number; lastSyncedAt: string | null };
}

// ── API response shapes ──────────────────────────────────────────────────────

interface ConnectionStatus {
  connected: boolean;
  realmId: string | null;
  environment: string | null;
  tokenExpiresAt: string | null;
  connectedAt: string | null;
  companyName: string | null;
  currency: string | null;
}

interface QueueStatus {
  pendingCount: number;
  failedCount: number;
  pushedSalesCount: number;
  lastSyncedAt: string | null;
  quickbooksConnected: boolean;
}

interface SyncLogRow {
  id: string;
  entityType: string;
  direction: string;
  status: SyncState;
  message: string | null;
  createdAt: string;
}

const LOG_TYPE_BY_ENTITY: Record<string, QbLogType> = {
  PRODUCT: 'PRODUCT_PULL',
  SALE: 'SALE_PUSH',
  RETURN: 'RETURN_PUSH',
  CUSTOMER: 'CUSTOMER_PULL',
  SUPPLIER: 'VENDOR_PULL',
  CONNECTION: 'CONNECTION',
};

function auth(session: Session): { token: string; tenantId: string } {
  return { token: session.token, tenantId: session.user.tenantId };
}

function latestOf(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

function buildState(
  connection: ConnectionStatus,
  queue: QueueStatus | null,
  logs: SyncLogRow[],
  products: QbProduct[],
  parties: PartySyncStatus | null,
): QbState {
  if (!connection.connected || !connection.realmId) {
    return DISCONNECTED_STATE;
  }

  const log: QbLogEntry[] = logs.map((row) => ({
    id: row.id,
    tsISO: row.createdAt,
    type: LOG_TYPE_BY_ENTITY[row.entityType] ?? 'CONNECTION',
    direction: row.direction === 'OUTBOUND' ? 'OUTBOUND' : 'INBOUND',
    status: row.status,
    message: row.message ?? '',
  }));

  const lastProductPull = log.find((l) => l.type === 'PRODUCT_PULL');
  const productSyncStatus: SyncState =
    lastProductPull?.status ?? (products.length > 0 ? 'SYNCED' : 'NOT_SYNCED');

  const salesSyncStatus: SyncState = !queue
    ? 'NOT_SYNCED'
    : queue.failedCount > 0
      ? 'FAILED'
      : queue.pendingCount > 0
        ? 'PENDING'
        : queue.pushedSalesCount > 0
          ? 'SYNCED'
          : 'NOT_SYNCED';

  const environment = connection.environment
    ? connection.environment.charAt(0).toUpperCase() + connection.environment.slice(1)
    : 'Sandbox';

  return {
    connected: true,
    company: {
      name: connection.companyName ?? `QuickBooks company ${connection.realmId}`,
      realmId: connection.realmId,
      environment,
      currency: connection.currency,
    },
    connectedAtISO: connection.connectedAt,
    lastSyncISO: latestOf(lastProductPull?.tsISO ?? null, queue?.lastSyncedAt ?? null),
    productSync: {
      status: productSyncStatus,
      count: products.length,
      lastSyncISO: lastProductPull?.tsISO ?? null,
    },
    salesSync: {
      status: salesSyncStatus,
      pushed: queue?.pushedSalesCount ?? 0,
      lastSyncISO: queue?.lastSyncedAt ?? null,
    },
    customerSync: {
      status: (parties?.customers.linked ?? 0) > 0 ? 'SYNCED' : 'NOT_SYNCED',
      linked: parties?.customers.linked ?? 0,
      total: parties?.customers.total ?? 0,
      lastSyncISO: parties?.customers.lastSyncedAt ?? null,
    },
    vendorSync: {
      status:
        (parties?.vendors.attention ?? 0) > 0
          ? 'FAILED'
          : (parties?.vendors.linked ?? 0) > 0
            ? 'SYNCED'
            : 'NOT_SYNCED',
      linked: parties?.vendors.linked ?? 0,
      total: parties?.vendors.total ?? 0,
      attention: parties?.vendors.attention ?? 0,
      lastSyncISO: parties?.vendors.lastSyncedAt ?? null,
    },
    errorsCount: queue?.failedCount ?? 0,
    log,
    products,
  };
}

interface QuickBooksContextValue {
  state: QbState;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  /** Fetch the Intuit authorization URL and navigate the browser to it. */
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  /** Trigger a product pull; resolves with the summary (null on failure). */
  syncProducts: () => Promise<SyncProductsSummary | null>;
  /** Full sync: products + customer/vendor mapping reconciliation. */
  syncAll: () => Promise<SyncAllSummary | null>;
}

const QuickBooksContext = React.createContext<QuickBooksContextValue | null>(null);

export function QuickBooksProvider({ children }: { children: React.ReactNode }) {
  const { session } = useAuth();
  const [state, setState] = React.useState<QbState>(DISCONNECTED_STATE);
  const [loading, setLoading] = React.useState(true);
  const [syncing, setSyncing] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    if (!session) {
      setState(DISCONNECTED_STATE);
      setLoading(false);
      return;
    }
    try {
      const connection = await api.get<ConnectionStatus>('/quickbooks/status', auth(session));
      if (!connection.connected) {
        setState(DISCONNECTED_STATE);
        setError(null);
        return;
      }
      // Secondary data is best-effort: a failed piece degrades to empty, not a dead page.
      const [queue, logs, products, parties] = await Promise.allSettled([
        api.get<QueueStatus>('/sync/status', auth(session)),
        api.get<{ items: SyncLogRow[] }>('/sync/logs?page=1&pageSize=50', auth(session)),
        fetchProducts(session, { pageSize: 200 }),
        api.get<PartySyncStatus>('/quickbooks/party-sync-status', auth(session)),
      ]);
      setState(
        buildState(
          connection,
          queue.status === 'fulfilled' ? queue.value : null,
          logs.status === 'fulfilled' ? logs.value.items : [],
          products.status === 'fulfilled'
            ? products.value.items
                .filter((p) => p.quickbooksItemId != null)
                .map((p) => ({
                  id: p.id,
                  name: p.name,
                  sku: p.sku,
                  quickbooksItemId: p.quickbooksItemId as string,
                  unitPrice: p.unitPrice,
                  quantityOnHand: p.quantityOnHand,
                  syncStatus: p.syncStatus,
                  lastSyncISO: p.lastSyncedAt,
                }))
            : [],
          parties.status === 'fulfilled' ? parties.value : null,
        ),
      );
      setError(null);
    } catch (err) {
      setState(DISCONNECTED_STATE);
      setError(err instanceof Error ? err.message : 'Could not load QuickBooks status');
    } finally {
      setLoading(false);
    }
  }, [session]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const connect = React.useCallback(async () => {
    if (!session) return;
    const { url } = await api.get<{ url: string }>('/quickbooks/connect', auth(session));
    window.location.assign(url);
  }, [session]);

  const disconnect = React.useCallback(async () => {
    if (!session) return;
    try {
      await api.post('/quickbooks/disconnect', undefined, auth(session));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Disconnect failed');
    }
    await refresh();
  }, [session, refresh]);

  const syncProducts = React.useCallback(async (): Promise<SyncProductsSummary | null> => {
    if (!session) return null;
    setSyncing(true);
    try {
      const summary = await syncQuickBooksProducts(session);
      await refresh();
      return summary;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Product sync failed');
      return null;
    } finally {
      setSyncing(false);
    }
  }, [session, refresh]);

  const syncAll = React.useCallback(async (): Promise<SyncAllSummary | null> => {
    if (!session) return null;
    setSyncing(true);
    try {
      const summary = await syncQuickBooksAll(session);
      await refresh();
      return summary;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'QuickBooks sync failed');
      return null;
    } finally {
      setSyncing(false);
    }
  }, [session, refresh]);

  const value = React.useMemo(() => {
    // While a sync runs, every entity the combined sync touches shows as
    // in-flight — not just products.
    const visibleState = syncing
      ? {
          ...state,
          productSync: { ...state.productSync, status: 'SYNCING' as SyncState },
          customerSync: { ...state.customerSync, status: 'SYNCING' as SyncState },
          vendorSync: { ...state.vendorSync, status: 'SYNCING' as SyncState },
        }
      : state;
    return { state: visibleState, loading, error, refresh, connect, disconnect, syncProducts, syncAll };
  }, [state, syncing, loading, error, refresh, connect, disconnect, syncProducts, syncAll]);

  return <QuickBooksContext.Provider value={value}>{children}</QuickBooksContext.Provider>;
}

export function useQuickBooks(): QuickBooksContextValue {
  const ctx = React.useContext(QuickBooksContext);
  if (!ctx) throw new Error('useQuickBooks must be used within a QuickBooksProvider');
  return ctx;
}

/** Deterministic timestamp formatting (avoids locale/timezone hydration issues). */
export function formatQbTime(iso: string | null): string {
  if (!iso) return '—';
  return iso.replace('T', ' ').slice(0, 16) + ' UTC';
}
