import { api } from './api';
import type { Session } from './auth';

/** Aggregated store-activity numbers for the dashboard tiles (mirrors the API). */
export interface DashboardStats {
  todaySalesTotal: number;
  todayTransactions: number;
  productsCached: number;
  pendingSyncs: number;
  /** Stock on hand valued at cost across active Inventory products. */
  inventoryValue: number;
  /** Active Inventory products with stock on hand. */
  stockedProducts: number;
}

/** Raw stats JSON (Prisma Decimal totals may arrive as strings). */
type ApiDashboardStats = Omit<DashboardStats, 'todaySalesTotal' | 'inventoryValue'> & {
  todaySalesTotal: string | number;
  inventoryValue: string | number;
};

export async function fetchDashboardStats(session: Session): Promise<DashboardStats> {
  const s = await api.get<ApiDashboardStats>('/dashboard/stats', {
    token: session.token,
    tenantId: session.user.tenantId,
  });
  return {
    ...s,
    todaySalesTotal: Number(s.todaySalesTotal),
    inventoryValue: Number(s.inventoryValue ?? 0),
  };
}

// ── aggregation endpoints (real replacements for the old demo adapters) ──────

export interface RangedMetric {
  value: number;
  prevValue: number;
  /** Per-day values across the window (sparkline material). */
  series: number[];
}

export interface DashboardSummary {
  from: string;
  to: string;
  prevFrom: string;
  prevTo: string;
  netSales: RangedMetric;
  transactions: RangedMetric;
  grossProfit: RangedMetric;
}

export interface PaymentMethodTotal {
  method: string;
  amount: number;
  /** Number of payment records captured with this method in the window. */
  count: number;
}

export interface RankedCategoryApi {
  label: string;
  amount: number;
  /** Total units sold across the category in the window. */
  units: number;
  /** Number of distinct sales that included an item in this category. */
  count: number;
}

export interface RankedProductApi {
  productId: string | null;
  name: string;
  imageUrl: string | null;
  quantity: number;
  amount: number;
}

export interface ShiftSummaryApi {
  startedAt: string | null;
  transactions: number;
  cashSales: number;
  cardSales: number;
  bankQrSales: number;
  otherSales: number;
  refunds: number;
  expectedCash: number;
}

export interface SeriesPointApi {
  bucket: string;
  value: number;
}

function auth(session: Session): { token: string; tenantId: string } {
  return { token: session.token, tenantId: session.user.tenantId };
}

export function fetchDashboardSummary(session: Session): Promise<DashboardSummary> {
  return api.get<DashboardSummary>('/dashboard/summary', auth(session));
}

export function fetchPaymentMethods(
  session: Session,
  opts: { mine?: boolean } = {},
): Promise<PaymentMethodTotal[]> {
  return api.get<PaymentMethodTotal[]>(
    `/dashboard/payment-methods${opts.mine ? '?mine=true' : ''}`,
    auth(session),
  );
}

export function fetchTopCategories(session: Session, limit = 5): Promise<RankedCategoryApi[]> {
  return api.get<RankedCategoryApi[]>(`/dashboard/top-categories?limit=${limit}`, auth(session));
}

export function fetchTopProducts(
  session: Session,
  opts: { limit?: number; mine?: boolean } = {},
): Promise<RankedProductApi[]> {
  const params = new URLSearchParams();
  params.set('limit', String(opts.limit ?? 6));
  if (opts.mine) params.set('mine', 'true');
  return api.get<RankedProductApi[]>(`/dashboard/top-products?${params.toString()}`, auth(session));
}

export function fetchShiftSummary(session: Session): Promise<ShiftSummaryApi> {
  return api.get<ShiftSummaryApi>('/dashboard/shift-summary', auth(session));
}

export function fetchSalesSeries(
  session: Session,
  opts: { from?: Date; to?: Date; interval?: 'day' | 'hour' } = {},
): Promise<SeriesPointApi[]> {
  const params = new URLSearchParams();
  if (opts.from) params.set('from', opts.from.toISOString());
  if (opts.to) params.set('to', opts.to.toISOString());
  if (opts.interval) params.set('interval', opts.interval);
  const qs = params.toString();
  return api.get<SeriesPointApi[]>(`/dashboard/sales-series${qs ? `?${qs}` : ''}`, auth(session));
}
