import { Injectable } from '@nestjs/common';
import { FulfilmentKind, OrderChannel } from '@hardware-pos/database';

import { PrismaService } from '../../prisma/prisma.service';

/*
 * D62 — re-backed by the settlement document (convergence plan §9.2).
 *
 * These reports existed as a parallel stack because restaurant sales had no
 * SaleItem rows (plan defect D-3). D58 fixed that, so the FINANCIAL figures
 * now read Sale/SaleItem — the same source retail reporting reads — while
 * the operational counts (sessions handled, rounds submitted, voids) stay on
 * the operational store, which is what they are about.
 *
 * One recorded semantic shift: revenue and item figures now measure SETTLED
 * documents (completedAt in range) rather than ordered-but-possibly-unsettled
 * items. The bill a customer has not yet paid is service in progress, not
 * revenue — the old numbers could count food that was later voided at the
 * table or sitting on a still-open session.
 */

interface DateRange {
  from: Date;
  to: Date;
}

export interface SalesSummary {
  branchId: string;
  from: string;
  to: string;
  sessionsClosed: number;
  ordersServed: number;
  itemsSold: string;
  netRevenue: string;
  serviceChargeCollected: string;
  paymentsCollected: string;
  bySaleStatus: Record<string, number>;
}

export interface TopMenuItem {
  menuItemId: string;
  menuItemName: string;
  quantitySold: string;
  revenue: string;
}

export interface WaiterPerformance {
  userId: string;
  sessionsHandled: number;
  roundsSubmitted: number;
  totalRevenue: string;
}

export interface PaymentBreakdown {
  method: string;
  count: number;
  amount: string;
}

export interface VoidReportItem {
  itemId: string;
  menuItemName: string;
  quantity: string;
  reason: string;
  voidedAt: string;
  voidedByUserId: string | null;
}

@Injectable()
export class RestaurantReportsService {
  constructor(private readonly prisma: PrismaService) {}

  async salesSummary(tenantId: string, branchId: string, range: DateRange): Promise<SalesSummary> {
    // Financial figures from the settlement document; ordersServed stays an
    // operational count over the settled sessions' orders.
    const sales = await this.prisma.sale.findMany({
      where: {
        tenantId,
        branchId,
        fulfilmentKind: FulfilmentKind.TABLE_SERVICE,
        completedAt: { gte: range.from, lte: range.to },
      },
      include: { items: { select: { quantity: true } } },
    });
    const bySaleStatus: Record<string, number> = {};
    let paymentsCollected = 0;
    let serviceChargeCollected = 0;
    let netRevenue = 0;
    let itemsSold = 0;
    for (const sale of sales) {
      bySaleStatus[sale.status] = (bySaleStatus[sale.status] ?? 0) + 1;
      paymentsCollected += Number(sale.paidAmount);
      serviceChargeCollected += Number(sale.serviceChargeAmount);
      netRevenue += Number(sale.total);
      itemsSold += sale.items.reduce((a, i) => a + Number(i.quantity), 0);
    }
    const sessionIds = sales
      .filter((s) => s.sourceRefKind === 'TABLE_SESSION' && s.sourceRefId)
      .map((s) => s.sourceRefId as string);
    const ordersServed = sessionIds.length
      ? await this.prisma.restaurantOrder.count({ where: { sessionId: { in: sessionIds } } })
      : 0;
    return {
      branchId,
      from: range.from.toISOString(),
      to: range.to.toISOString(),
      sessionsClosed: sessionIds.length,
      ordersServed,
      itemsSold: itemsSold.toFixed(3),
      netRevenue: netRevenue.toFixed(2),
      serviceChargeCollected: serviceChargeCollected.toFixed(2),
      paymentsCollected: paymentsCollected.toFixed(2),
      bySaleStatus,
    };
  }

  async topItems(
    tenantId: string,
    branchId: string,
    range: DateRange,
    limit = 10,
  ): Promise<TopMenuItem[]> {
    // Aggregate SETTLED lines from the sale document — the same source
    // product-level retail reporting reads. The response keeps its shape:
    // `menuItemId` carries the product id (the one reference D60 converged
    // on), falling back to a name key for unmigrated legacy lines.
    const items = await this.prisma.saleItem.findMany({
      where: {
        sale: {
          tenantId,
          branchId,
          fulfilmentKind: FulfilmentKind.TABLE_SERVICE,
          completedAt: { gte: range.from, lte: range.to },
        },
      },
      select: { productId: true, productName: true, quantity: true, lineTotal: true },
    });
    const map = new Map<string, { name: string; qty: number; revenue: number }>();
    for (const i of items) {
      const key = i.productId ?? `name:${i.productName}`;
      const existing = map.get(key) ?? { name: i.productName, qty: 0, revenue: 0 };
      existing.qty += Number(i.quantity);
      existing.revenue += Number(i.lineTotal);
      map.set(key, existing);
    }
    return [...map.entries()]
      .map(([menuItemId, v]) => ({
        menuItemId,
        menuItemName: v.name,
        quantitySold: v.qty.toFixed(3),
        revenue: v.revenue.toFixed(2),
      }))
      .sort((a, b) => Number(b.revenue) - Number(a.revenue))
      .slice(0, limit);
  }

  async waiterPerformance(
    tenantId: string,
    branchId: string,
    range: DateRange,
  ): Promise<WaiterPerformance[]> {
    const sessions = await this.prisma.tableSession.findMany({
      where: {
        tenantId,
        branchId,
        openedAt: { gte: range.from, lte: range.to },
        waiterUserId: { not: null },
      },
      include: { orders: { include: { rounds: { select: { id: true } } } } },
    });
    const map = new Map<string, WaiterPerformance>();
    for (const s of sessions) {
      const key = s.waiterUserId!;
      const view = map.get(key) ?? {
        userId: key,
        sessionsHandled: 0,
        roundsSubmitted: 0,
        totalRevenue: '0.00',
      };
      view.sessionsHandled += 1;
      view.roundsSubmitted += s.orders.reduce((n, o) => n + o.rounds.length, 0);
      map.set(key, view);
    }
    // Revenue from the settlement document's own attribution (D58/Q6:
    // servedByUserId is who served; cashierId is who took the money) —
    // no join back through the session needed.
    const revenue = await this.prisma.sale.groupBy({
      by: ['servedByUserId'],
      where: {
        tenantId,
        branchId,
        fulfilmentKind: FulfilmentKind.TABLE_SERVICE,
        completedAt: { gte: range.from, lte: range.to },
        servedByUserId: { not: null },
      },
      _sum: { total: true },
    });
    for (const row of revenue) {
      const v = map.get(row.servedByUserId!);
      if (!v) continue;
      v.totalRevenue = Number(row._sum.total ?? 0).toFixed(2);
    }
    return [...map.values()].sort((a, b) => Number(b.totalRevenue) - Number(a.totalRevenue));
  }

  async paymentBreakdown(
    tenantId: string,
    branchId: string,
    range: DateRange,
  ): Promise<PaymentBreakdown[]> {
    const payments = await this.prisma.payment.findMany({
      where: {
        tenantId,
        createdAt: { gte: range.from, lte: range.to },
        sale: { branchId },
      },
      select: { method: true, amount: true },
    });
    const map = new Map<string, { count: number; amount: number }>();
    for (const p of payments) {
      const v = map.get(p.method) ?? { count: 0, amount: 0 };
      v.count += 1;
      v.amount += Number(p.amount);
      map.set(p.method, v);
    }
    return [...map.entries()].map(([method, v]) => ({
      method,
      count: v.count,
      amount: v.amount.toFixed(2),
    }));
  }

  async voidReport(
    tenantId: string,
    branchId: string,
    range: DateRange,
  ): Promise<VoidReportItem[]> {
    const rows = await this.prisma.restaurantOrderItem.findMany({
      where: {
        tenantId,
        status: 'VOIDED',
        voidedAt: { gte: range.from, lte: range.to },
        order: { branchId },
      },
      orderBy: { voidedAt: 'desc' },
    });
    return rows.map((r) => ({
      itemId: r.id,
      menuItemName: r.menuItemName,
      quantity: r.quantity.toFixed(3),
      reason: r.voidReason ?? '',
      voidedAt: r.voidedAt?.toISOString() ?? '',
      voidedByUserId: r.voidedByUserId,
    }));
  }

  async channelBreakdown(
    tenantId: string,
    branchId: string,
    range: DateRange,
  ): Promise<{ channel: OrderChannel; orders: number }[]> {
    // D62: the channel lives on the settlement document now (D58 — before,
    // this joined through the operational order). `orders` counts settled
    // sales per channel; a bill not yet paid is service in progress, not a
    // channel statistic.
    const rows = await this.prisma.sale.groupBy({
      by: ['channel'],
      where: {
        tenantId,
        branchId,
        fulfilmentKind: FulfilmentKind.TABLE_SERVICE,
        completedAt: { gte: range.from, lte: range.to },
      },
      _count: { _all: true },
    });
    return rows.map((r) => ({ channel: r.channel, orders: r._count._all }));
  }
}
