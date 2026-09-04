/** Pure transforms: raw API rows → dashboard view-models. No fetching here. */
import type { SaleReturnStatusCode } from '@hardware-pos/shared';

import type { ClientProduct } from '@/lib/catalog';
import type { QuotationListItem } from '@/lib/quotations';
import type {
  DashboardStats,
  PaymentMethodTotal,
  RankedCategoryApi,
  RankedProductApi,
  ShiftSummaryApi,
} from '@/lib/dashboard-api';
import type { PaymentStatusCode, SyncStatusCode } from '@/lib/sales';

import type {
  BreakdownRow,
  FrequentItem,
  MetricComparison,
  PipelineStage,
  QuickBooksHealth,
  RankedRow,
  ShiftSummary,
} from './types';

export interface QuotationPipeline {
  stages: PipelineStage[];
  /** DRAFT + SENT. */
  openCount: number;
  totalValue: number;
  totalCount: number;
}

const PIPELINE_DEF: { key: string; label: string; tone: PipelineStage['tone']; match: string[] }[] =
  [
    { key: 'draft', label: 'Draft', tone: 'muted', match: ['DRAFT'] },
    { key: 'sent', label: 'Sent', tone: 'primary', match: ['SENT', 'REVISED'] },
    { key: 'accepted', label: 'Accepted', tone: 'success', match: ['ACCEPTED'] },
    { key: 'converted', label: 'Converted', tone: 'success', match: ['CONVERTED_TO_SALE'] },
    {
      key: 'expired',
      label: 'Expired',
      tone: 'danger',
      match: ['EXPIRED', 'REJECTED', 'CANCELLED'],
    },
  ];

export function buildQuotationPipeline(quotations: QuotationListItem[]): QuotationPipeline {
  const stages: PipelineStage[] = PIPELINE_DEF.map((def) => {
    const rows = quotations.filter((q) => def.match.includes(q.status));
    return {
      key: def.key,
      label: def.label,
      tone: def.tone,
      count: rows.length,
      value: rows.reduce((s, q) => s + q.grandTotal, 0),
    };
  });
  const openCount = quotations.filter((q) => q.status === 'DRAFT' || q.status === 'SENT').length;
  return {
    stages,
    openCount,
    totalValue: quotations.reduce((s, q) => s + q.grandTotal, 0),
    totalCount: quotations.length,
  };
}

export function buildQuickBooksHealth(
  stats: DashboardStats | null,
  failedSyncs: number,
): QuickBooksHealth {
  const waiting = stats?.pendingSyncs ?? 0;
  const status =
    failedSyncs > 0
      ? 'danger'
      : waiting > 0
        ? 'warning'
        : ('success' as QuickBooksHealth['status']);
  return {
    state: 'connected',
    status,
    statusLabel:
      failedSyncs > 0 ? 'Attention required' : waiting > 0 ? 'Delayed' : 'All systems operational',
    lastSyncLabel: null,
    waitingToSync: waiting,
    failedSyncs,
  };
}

// ── status → label / tone (used by transaction + sales tables) ───────────────

export function paymentStatusMeta(
  status: PaymentStatusCode,
  returnStatus?: SaleReturnStatusCode,
): { label: string; tone: 'success' | 'warning' | 'danger' | 'muted' } {
  if (returnStatus === 'FULLY_RETURNED' || returnStatus === 'PARTIALLY_RETURNED') {
    return { label: 'Returned', tone: 'danger' };
  }
  switch (status) {
    case 'PAID':
      return { label: 'Paid', tone: 'success' };
    case 'REFUNDED':
      return { label: 'Refund', tone: 'danger' };
    default:
      // PARTIAL falls through with UNPAID: a sale that still owes anything is a
      // credit sale, and the dashboard has no room to draw a distinction the
      // shop does not make. (The compact 'Credit' is this surface's own wording
      // for the same thing the sales list spells out in full.)
      return { label: 'Credit', tone: 'muted' };
  }
}

export function syncStatusMeta(status: SyncStatusCode): {
  label: string;
  tone: 'success' | 'warning' | 'danger' | 'muted';
} {
  switch (status) {
    case 'SYNCED':
      return { label: 'Synced', tone: 'success' };
    case 'FAILED':
      return { label: 'Sync failed', tone: 'danger' };
    case 'PENDING':
    case 'SYNCING':
      return { label: 'Sync pending', tone: 'warning' };
    default:
      return { label: 'Not synced', tone: 'muted' };
  }
}

// ── real-aggregate view-model builders (replacing the demo adapters) ─────────

/** Percentage change vs the previous window; undefined when there's no baseline. */
export function buildComparison(
  value: number,
  prevValue: number,
  label = 'vs previous 7 days',
): MetricComparison | undefined {
  if (prevValue <= 0) return undefined;
  const pct = ((value - prevValue) / prevValue) * 100;
  return {
    value: Math.round(pct * 10) / 10,
    direction: pct > 0.5 ? 'up' : pct < -0.5 ? 'down' : 'neutral',
    label,
  };
}

const PAYMENT_LABELS: Record<string, { label: string; tone: BreakdownRow['tone'] }> = {
  CASH: { label: 'Cash', tone: 'cash' },
  CARD: { label: 'Card', tone: 'card' },
  BANK_TRANSFER: { label: 'Bank transfer', tone: 'bank' },
  QR_PAYMENT: { label: 'QR payment', tone: 'qr' },
  CHECK: { label: 'Cheque', tone: 'other' },
  STORE_CREDIT: { label: 'Store credit', tone: 'credit' },
};

export function buildPaymentBreakdown(totals: PaymentMethodTotal[]): BreakdownRow[] {
  const sum = totals.reduce((n, t) => n + t.amount, 0);
  return [...totals]
    .sort((a, b) => b.amount - a.amount)
    .map((t) => {
      const meta = PAYMENT_LABELS[t.method] ?? { label: t.method, tone: 'other' as const };
      return {
        key: t.method,
        label: meta.label,
        amount: t.amount,
        percent: sum > 0 ? Math.round((t.amount / sum) * 100) : 0,
        tone: meta.tone,
      };
    });
}

export function buildTopCategoryRows(categories: RankedCategoryApi[]): RankedRow[] {
  const max = categories.reduce((m, c) => Math.max(m, c.amount), 0);
  return categories.map((c) => ({
    key: c.label,
    label: c.label,
    amount: c.amount,
    percent: max > 0 ? Math.round((c.amount / max) * 100) : 0,
  }));
}

export function buildFrequentItems(products: RankedProductApi[]): FrequentItem[] {
  return products.map((p) => ({
    key: p.productId ?? p.name,
    name: p.name,
    imageUrl: p.imageUrl,
    quantity: p.quantity,
    amount: p.amount,
  }));
}

/**
 * Shift view from the cashier's real activity. There is no drawer-session
 * feature yet, so the drawer starts at zero and never records counts —
 * expected cash equals cash sales minus refunds and the difference is 0.
 */
export function buildShiftSummary(api: ShiftSummaryApi | null): ShiftSummary {
  if (!api) {
    return {
      isOpen: false,
      startedAtLabel: 'No sales yet today',
      startingCash: 0,
      cashSales: 0,
      cardSales: 0,
      bankQrSales: 0,
      refunds: 0,
      expectedCash: 0,
      drawerBalance: 0,
      difference: 0,
    };
  }
  return {
    isOpen: api.startedAt != null,
    startedAtLabel: api.startedAt
      ? new Date(api.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : 'No sales yet today',
    startingCash: 0,
    cashSales: api.cashSales,
    cardSales: api.cardSales,
    bankQrSales: api.bankQrSales,
    refunds: api.refunds,
    expectedCash: api.expectedCash,
    drawerBalance: api.expectedCash,
    difference: 0,
  };
}
