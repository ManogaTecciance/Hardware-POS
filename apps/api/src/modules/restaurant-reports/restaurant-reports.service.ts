import { Injectable } from '@nestjs/common';
import { RestaurantOrderChannel } from '@hardware-pos/database';

import { PrismaService } from '../../prisma/prisma.service';

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
    const sessions = await this.prisma.tableSession.findMany({
      where: {
        tenantId,
        branchId,
        status: 'CLOSED',
        closedAt: { gte: range.from, lte: range.to },
      },
      include: {
        orders: {
          include: { items: { where: { status: { not: 'VOIDED' } } } },
        },
      },
    });
    const saleIds = sessions.map((s) => s.finalSaleId).filter((id): id is string => !!id);
    const sales = saleIds.length
      ? await this.prisma.sale.findMany({ where: { id: { in: saleIds } } })
      : [];
    const bySaleStatus: Record<string, number> = {};
    let paymentsCollected = 0;
    let serviceChargeCollected = 0;
    let netRevenue = 0;
    for (const sale of sales) {
      bySaleStatus[sale.status] = (bySaleStatus[sale.status] ?? 0) + 1;
      paymentsCollected += Number(sale.paidAmount);
      serviceChargeCollected += Number(sale.serviceChargeAmount);
      netRevenue += Number(sale.total);
    }
    const itemsSold = sessions
      .flatMap((s) => s.orders.flatMap((o) => o.items.map((i) => Number(i.quantity))))
      .reduce((a, b) => a + b, 0);
    return {
      branchId,
      from: range.from.toISOString(),
      to: range.to.toISOString(),
      sessionsClosed: sessions.length,
      ordersServed: sessions.flatMap((s) => s.orders).length,
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
    // Aggregate per menu item across the range's non-voided items.
    const items = await this.prisma.restaurantOrderItem.findMany({
      where: {
        tenantId,
        status: { not: 'VOIDED' },
        createdAt: { gte: range.from, lte: range.to },
        order: { branchId },
      },
      select: {
        menuItemId: true,
        menuItemName: true,
        quantity: true,
        unitPrice: true,
        modifierTotal: true,
      },
    });
    const map = new Map<string, { name: string; qty: number; revenue: number }>();
    for (const i of items) {
      const existing = map.get(i.menuItemId) ?? { name: i.menuItemName, qty: 0, revenue: 0 };
      existing.qty += Number(i.quantity);
      existing.revenue +=
        (Number(i.unitPrice) + Number(i.modifierTotal)) * Number(i.quantity);
      map.set(i.menuItemId, existing);
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
    // Sum revenue from the closed sessions' Sales.
    const closed = sessions.filter((s) => s.finalSaleId);
    const saleIds = closed.map((s) => s.finalSaleId!) as string[];
    const sales = saleIds.length
      ? await this.prisma.sale.findMany({ where: { id: { in: saleIds } } })
      : [];
    const bySession = new Map(closed.map((s) => [s.finalSaleId!, s.waiterUserId!]));
    for (const sale of sales) {
      const waiter = bySession.get(sale.id);
      if (!waiter) continue;
      const v = map.get(waiter);
      if (!v) continue;
      v.totalRevenue = (Number(v.totalRevenue) + Number(sale.total)).toFixed(2);
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
  ): Promise<{ channel: RestaurantOrderChannel; orders: number }[]> {
    const rows = await this.prisma.restaurantOrder.groupBy({
      by: ['channel'],
      where: {
        tenantId,
        branchId,
        createdAt: { gte: range.from, lte: range.to },
      },
      _count: { _all: true },
    });
    return rows.map((r) => ({ channel: r.channel, orders: r._count._all }));
  }
}
