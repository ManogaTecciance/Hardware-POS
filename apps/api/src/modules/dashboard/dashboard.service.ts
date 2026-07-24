import { Injectable } from '@nestjs/common';

import { DashboardRepository } from './dashboard.repository';
import {
  DashboardStats,
  DashboardSummary,
  PaymentMethodTotal,
  RankedCategory,
  RankedProduct,
  SeriesPoint,
  ShiftSummary,
} from './dashboard.types';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Default window: the last 7 days including today (local midnights). */
function defaultRange(): { from: Date; to: Date } {
  const to = new Date();
  to.setHours(24, 0, 0, 0);
  const from = new Date(to.getTime() - 7 * DAY_MS);
  return { from, to };
}

function resolveRange(from?: Date, to?: Date): { from: Date; to: Date } {
  const def = defaultRange();
  return { from: from ?? def.from, to: to ?? def.to };
}

/** The equal-length window immediately before [from, to). */
function previousWindow(from: Date, to: Date): { from: Date; to: Date } {
  const span = to.getTime() - from.getTime();
  return { from: new Date(from.getTime() - span), to: from };
}

/** Distribute bucketed sums over the window's days (zero-filled). */
function zeroFilledSeries(
  buckets: { bucket: Date; value: number }[],
  from: Date,
  to: Date,
): number[] {
  const days = Math.max(1, Math.round((to.getTime() - from.getTime()) / DAY_MS));
  const series = new Array<number>(days).fill(0);
  for (const b of buckets) {
    const idx = Math.floor((new Date(b.bucket).getTime() - from.getTime()) / DAY_MS);
    if (idx >= 0 && idx < days) series[idx] = (series[idx] ?? 0) + b.value;
  }
  return series;
}

@Injectable()
export class DashboardService {
  constructor(private readonly dashboardRepository: DashboardRepository) {}

  getStats(tenantId: string): Promise<DashboardStats> {
    return this.dashboardRepository.getStats(tenantId);
  }

  async summary(tenantId: string, fromIn?: Date, toIn?: Date): Promise<DashboardSummary> {
    const { from, to } = resolveRange(fromIn, toIn);
    const prev = previousWindow(from, to);

    const [cur, prv, profit, prevProfit, buckets] = await Promise.all([
      this.dashboardRepository.rangeTotals(tenantId, from, to),
      this.dashboardRepository.rangeTotals(tenantId, prev.from, prev.to),
      this.dashboardRepository.rangeGrossProfit(tenantId, from, to),
      this.dashboardRepository.rangeGrossProfit(tenantId, prev.from, prev.to),
      this.dashboardRepository.salesSeries(tenantId, from, to, 'day'),
    ]);

    const salesSeries = zeroFilledSeries(buckets, from, to);
    // The per-day sales curve doubles as the spark direction for the other
    // KPIs; only Net Sales charts absolute per-day values today.
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      prevFrom: prev.from.toISOString(),
      prevTo: prev.to.toISOString(),
      netSales: { value: cur.netSales, prevValue: prv.netSales, series: salesSeries },
      transactions: {
        value: cur.transactions,
        prevValue: prv.transactions,
        series: salesSeries,
      },
      grossProfit: { value: profit, prevValue: prevProfit, series: salesSeries },
    };
  }

  async salesSeries(
    tenantId: string,
    fromIn?: Date,
    toIn?: Date,
    interval: 'day' | 'hour' = 'day',
  ): Promise<SeriesPoint[]> {
    const { from, to } = resolveRange(fromIn, toIn);
    const rows = await this.dashboardRepository.salesSeries(tenantId, from, to, interval);
    return rows.map((r) => ({ bucket: new Date(r.bucket).toISOString(), value: r.value }));
  }

  async paymentMethods(
    tenantId: string,
    fromIn?: Date,
    toIn?: Date,
    cashierId?: string,
  ): Promise<PaymentMethodTotal[]> {
    const { from, to } = resolveRange(fromIn, toIn);
    return this.dashboardRepository.paymentMethodTotals(tenantId, from, to, cashierId);
  }

  async topCategories(
    tenantId: string,
    fromIn?: Date,
    toIn?: Date,
    limit = 5,
  ): Promise<RankedCategory[]> {
    const { from, to } = resolveRange(fromIn, toIn);
    return this.dashboardRepository.topCategories(tenantId, from, to, limit);
  }

  async topProducts(
    tenantId: string,
    fromIn?: Date,
    toIn?: Date,
    limit = 5,
    cashierId?: string,
  ): Promise<RankedProduct[]> {
    const { from, to } = resolveRange(fromIn, toIn);
    return this.dashboardRepository.topProducts(tenantId, from, to, limit, cashierId);
  }

  /** The requesting cashier's activity since local midnight. */
  async shiftSummary(tenantId: string, cashierId: string): Promise<ShiftSummary> {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const now = new Date(startOfToday.getTime() + DAY_MS);

    const [methods, startedAt, refunds, totals] = await Promise.all([
      this.dashboardRepository.paymentMethodTotals(tenantId, startOfToday, now, cashierId),
      this.dashboardRepository.firstSaleAt(tenantId, cashierId, startOfToday),
      this.dashboardRepository.refundsSince(tenantId, startOfToday),
      this.dashboardRepository.rangeTotals(tenantId, startOfToday, now, cashierId),
    ]);

    const byMethod = new Map(methods.map((m) => [m.method, m.amount]));
    const cash = byMethod.get('CASH') ?? 0;
    const card = byMethod.get('CARD') ?? 0;
    const bankQr = (byMethod.get('BANK_TRANSFER') ?? 0) + (byMethod.get('QR_PAYMENT') ?? 0);
    const other = methods
      .filter((m) => !['CASH', 'CARD', 'BANK_TRANSFER', 'QR_PAYMENT'].includes(m.method))
      .reduce((n, m) => n + m.amount, 0);

    return {
      startedAt: startedAt?.toISOString() ?? null,
      transactions: totals.transactions,
      cashSales: cash,
      cardSales: card,
      bankQrSales: bankQr,
      otherSales: other,
      refunds,
      expectedCash: cash - refunds,
    };
  }
}
