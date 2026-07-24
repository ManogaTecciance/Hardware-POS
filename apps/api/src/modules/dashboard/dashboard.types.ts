/** A metric value with its previous-period counterpart and daily sparkline. */
export interface RangedMetric {
  value: number;
  prevValue: number;
  /** Per-day values across the window (sparkline material). */
  series: number[];
}

/** KPI aggregates for a date window, with previous-window comparisons. */
export interface DashboardSummary {
  from: string;
  to: string;
  prevFrom: string;
  prevTo: string;
  netSales: RangedMetric;
  transactions: RangedMetric;
  /** Revenue minus known product costs (upper bound while costs are partial). */
  grossProfit: RangedMetric;
}

export interface SeriesPoint {
  bucket: string;
  value: number;
}

export interface PaymentMethodTotal {
  method: string;
  amount: number;
  /** Number of payment records captured with this method in the window. */
  count: number;
}

export interface RankedCategory {
  label: string;
  amount: number;
  /** Total units sold across the category in the window. */
  units: number;
  /** Number of distinct sales that included an item in this category. */
  count: number;
}

export interface RankedProduct {
  productId: string | null;
  name: string;
  imageUrl: string | null;
  quantity: number;
  amount: number;
}

/** The signed-in cashier's activity since local midnight. */
export interface ShiftSummary {
  startedAt: string | null;
  transactions: number;
  cashSales: number;
  cardSales: number;
  bankQrSales: number;
  otherSales: number;
  refunds: number;
  /** Cash expected in the drawer from sales (no drawer-session tracking yet). */
  expectedCash: number;
}

/** Aggregated store-activity numbers for the dashboard tiles. */
export interface DashboardStats {
  /** Sum of completed sale totals since local midnight. */
  todaySalesTotal: number;
  /** Number of completed sales since local midnight. */
  todayTransactions: number;
  /** Active products in the local catalog cache. */
  productsCached: number;
  /** Completed sales not yet pushed to QuickBooks (pending, syncing, or failed). */
  pendingSyncs: number;
  /** Stock on hand valued at cost across active Inventory products. */
  inventoryValue: number;
  /** Active Inventory products with stock on hand. */
  stockedProducts: number;
}
