import { Injectable } from '@nestjs/common';
import {
  dayInTimeZone,
  daysInWindow,
  lastNDaysInTimeZone,
  safeTimeZone,
} from '@hardware-pos/shared';

import { SettingsService } from '../settings/settings.service';
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

/**
 * Default window: the last 7 days including today, cut on the SHOP's midnights.
 *
 * The shop's day is the unit the business reckons in — it is the day printed on
 * the invoice and filed in QuickBooks — so "today's sales" must run from one
 * local midnight to the next. Cutting on the server's midnight instead would, on
 * a UTC host serving a Colombo shop, report 05:30-to-05:30.
 */
function resolveRange(tz: string, from?: Date, to?: Date): { from: Date; to: Date } {
  const def = lastNDaysInTimeZone(7, tz);
  return { from: from ?? def.from, to: to ?? def.to };
}

/** The equal-length window immediately before [from, to), for period-on-period deltas. */
function previousWindow(from: Date, to: Date): { from: Date; to: Date } {
  const span = to.getTime() - from.getTime();
  return { from: new Date(from.getTime() - span), to: from };
}

/**
 * Distribute bucketed sums over the window's days (zero-filled).
 *
 * Indexed by the shop's calendar day rather than by dividing elapsed
 * milliseconds: a day is not always 24 hours long, so arithmetic on a fixed
 * DAY_MS silently mis-slots every bucket after a DST transition.
 */
function zeroFilledSeries(
  buckets: { bucket: Date; value: number }[],
  from: Date,
  to: Date,
  tz: string,
): number[] {
  const byDay = new Map<string, number>();
  for (const b of buckets) {
    const day = dayInTimeZone(new Date(b.bucket), tz);
    byDay.set(day, (byDay.get(day) ?? 0) + b.value);
  }
  return daysInWindow(from, to, tz).map((day) => byDay.get(day) ?? 0);
}

@Injectable()
export class DashboardService {
  constructor(
    private readonly dashboardRepository: DashboardRepository,
    private readonly settings: SettingsService,
  ) {}

  /** The zone the business reckons its days in. */
  private tz(tenantId: string): string {
    return safeTimeZone(this.settings.getSettings(tenantId).timezone);
  }

  getStats(tenantId: string): Promise<DashboardStats> {
    return this.dashboardRepository.getStats(tenantId, this.tz(tenantId));
  }

  async summary(tenantId: string, fromIn?: Date, toIn?: Date): Promise<DashboardSummary> {
    const tz = this.tz(tenantId);
    const { from, to } = resolveRange(tz, fromIn, toIn);
    const prev = previousWindow(from, to);

    const [cur, prv, profit, prevProfit, buckets] = await Promise.all([
      this.dashboardRepository.rangeTotals(tenantId, from, to),
      this.dashboardRepository.rangeTotals(tenantId, prev.from, prev.to),
      this.dashboardRepository.rangeGrossProfit(tenantId, from, to),
      this.dashboardRepository.rangeGrossProfit(tenantId, prev.from, prev.to),
      this.dashboardRepository.salesSeries(tenantId, from, to, 'day', tz),
    ]);

    const salesSeries = zeroFilledSeries(buckets, from, to, tz);
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
    const tz = this.tz(tenantId);
    const { from, to } = resolveRange(tz, fromIn, toIn);
    const rows = await this.dashboardRepository.salesSeries(tenantId, from, to, interval, tz);
    return rows.map((r) => ({ bucket: new Date(r.bucket).toISOString(), value: r.value }));
  }

  async paymentMethods(
    tenantId: string,
    fromIn?: Date,
    toIn?: Date,
    cashierId?: string,
  ): Promise<PaymentMethodTotal[]> {
    const tz = this.tz(tenantId);
    const { from, to } = resolveRange(tz, fromIn, toIn);
    return this.dashboardRepository.paymentMethodTotals(tenantId, from, to, cashierId);
  }

  async topCategories(
    tenantId: string,
    fromIn?: Date,
    toIn?: Date,
    limit = 5,
  ): Promise<RankedCategory[]> {
    const tz = this.tz(tenantId);
    const { from, to } = resolveRange(tz, fromIn, toIn);
    return this.dashboardRepository.topCategories(tenantId, from, to, limit);
  }

  async topProducts(
    tenantId: string,
    fromIn?: Date,
    toIn?: Date,
    limit = 5,
    cashierId?: string,
  ): Promise<RankedProduct[]> {
    const tz = this.tz(tenantId);
    const { from, to } = resolveRange(tz, fromIn, toIn);
    return this.dashboardRepository.topProducts(tenantId, from, to, limit, cashierId);
  }

  /** The requesting cashier's activity over the shop's current day. */
  async shiftSummary(tenantId: string, cashierId: string): Promise<ShiftSummary> {
    const { from: startOfToday, to: now } = lastNDaysInTimeZone(1, this.tz(tenantId));

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
