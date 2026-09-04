import { Injectable } from '@nestjs/common';
import { Prisma } from '@hardware-pos/database';

import { lastNDaysInTimeZone } from '@hardware-pos/shared';

import { CreditService } from '../credit/credit.service';
import { PrismaService } from '../../prisma/prisma.service';
import { DashboardStats } from './dashboard.types';

const COMPLETED = 'COMPLETED' as const;

@Injectable()
export class DashboardRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly credit: CreditService,
  ) {}

  /** Net sales + transaction count for a completed-sales window. */
  async rangeTotals(
    tenantId: string,
    from: Date,
    to: Date,
    cashierId?: string,
  ): Promise<{ netSales: number; transactions: number }> {
    const agg = await this.prisma.sale.aggregate({
      where: {
        tenantId,
        status: COMPLETED,
        completedAt: { gte: from, lt: to },
        ...(cashierId ? { cashierId } : {}),
      },
      _sum: { total: true },
      _count: { _all: true },
    });
    return { netSales: Number(agg._sum.total ?? 0), transactions: agg._count._all };
  }

  /**
   * Gross profit for the window: line revenue minus known product cost.
   * Items whose product has no costPrice contribute revenue with zero cost,
   * so treat this as an upper-bound estimate until costs are complete.
   */
  async rangeGrossProfit(tenantId: string, from: Date, to: Date): Promise<number> {
    const rows = await this.prisma.$queryRaw<{ profit: number | null }[]>(Prisma.sql`
      SELECT COALESCE(SUM(si."lineTotal" - COALESCE(p."costPrice", 0) * si.quantity), 0)::float AS profit
      FROM "SaleItem" si
      JOIN "Sale" s ON s.id = si."saleId"
      LEFT JOIN "Product" p ON p.id = si."productId"
      WHERE s."tenantId" = ${tenantId}
        AND s.status = 'COMPLETED'
        AND s."completedAt" >= ${from} AND s."completedAt" < ${to}
    `);
    return Number(rows[0]?.profit ?? 0);
  }

  /**
   * Daily (or hourly) net-sales buckets for charts/sparklines, cut on the SHOP's
   * clock rather than the database session's.
   *
   * `completedAt` is a `timestamp` holding a UTC wall clock, so the double
   * `AT TIME ZONE` is doing two different jobs: the first reads the naive value
   * back as a real UTC instant, the second re-expresses that instant as local
   * wall-clock time in `tz`. Truncating there gives the shop's day, and the
   * trailing `AT TIME ZONE` converts the bucket label back to an instant so the
   * API hands out a UTC value like everything else.
   */
  async salesSeries(
    tenantId: string,
    from: Date,
    to: Date,
    interval: 'day' | 'hour',
    tz: string,
  ): Promise<{ bucket: Date; value: number }[]> {
    const unit = interval === 'hour' ? 'hour' : 'day';
    return this.prisma.$queryRaw<{ bucket: Date; value: number }[]>(Prisma.sql`
      SELECT (
               date_trunc(${unit}, s."completedAt" AT TIME ZONE 'UTC' AT TIME ZONE ${tz})
                 AT TIME ZONE ${tz}
             ) AS bucket,
             COALESCE(SUM(s.total), 0)::float AS value
      FROM "Sale" s
      WHERE s."tenantId" = ${tenantId}
        AND s.status = 'COMPLETED'
        AND s."completedAt" >= ${from} AND s."completedAt" < ${to}
      GROUP BY 1
      ORDER BY 1
    `);
  }

  /** Amount received per payment method within the window. */
  async paymentMethodTotals(
    tenantId: string,
    from: Date,
    to: Date,
    cashierId?: string,
  ): Promise<{ method: string; amount: number; count: number }[]> {
    const grouped = await this.prisma.payment.groupBy({
      by: ['method'],
      where: {
        tenantId,
        sale: {
          status: COMPLETED,
          completedAt: { gte: from, lt: to },
          ...(cashierId ? { cashierId } : {}),
        },
      },
      _sum: { amount: true },
      _count: { _all: true },
    });
    return grouped.map((g) => ({
      method: g.method,
      amount: Number(g._sum.amount ?? 0),
      count: g._count._all,
    }));
  }

  /** Revenue per top-level category within the window. */
  async topCategories(
    tenantId: string,
    from: Date,
    to: Date,
    limit: number,
  ): Promise<{ label: string; amount: number; units: number; count: number }[]> {
    return this.prisma.$queryRaw<
      { label: string; amount: number; units: number; count: number }[]
    >(Prisma.sql`
      SELECT COALESCE(c.name, 'Uncategorized') AS label,
             COALESCE(SUM(si."lineTotal"), 0)::float AS amount,
             COALESCE(SUM(si.quantity), 0)::float AS units,
             COUNT(DISTINCT s.id)::int AS count
      FROM "SaleItem" si
      JOIN "Sale" s ON s.id = si."saleId"
      LEFT JOIN "Product" p ON p.id = si."productId"
      LEFT JOIN "ProductCategory" c ON c.id = p."categoryId"
      WHERE s."tenantId" = ${tenantId}
        AND s.status = 'COMPLETED'
        AND s."completedAt" >= ${from} AND s."completedAt" < ${to}
      GROUP BY 1
      ORDER BY amount DESC
      LIMIT ${limit}
    `);
  }

  /** Best-selling products (optionally for one cashier) within the window. */
  async topProducts(
    tenantId: string,
    from: Date,
    to: Date,
    limit: number,
    cashierId?: string,
  ): Promise<{ productId: string | null; name: string; imageUrl: string | null; quantity: number; amount: number }[]> {
    return this.prisma.$queryRaw<
      { productId: string | null; name: string; imageUrl: string | null; quantity: number; amount: number }[]
    >(Prisma.sql`
      SELECT si."productId" AS "productId",
             si."productName" AS name,
             MAX(p."imageUrl") AS "imageUrl",
             COALESCE(SUM(si.quantity), 0)::float AS quantity,
             COALESCE(SUM(si."lineTotal"), 0)::float AS amount
      FROM "SaleItem" si
      JOIN "Sale" s ON s.id = si."saleId"
      LEFT JOIN "Product" p ON p.id = si."productId"
      WHERE s."tenantId" = ${tenantId}
        AND s.status = 'COMPLETED'
        AND s."completedAt" >= ${from} AND s."completedAt" < ${to}
        ${cashierId ? Prisma.sql`AND s."cashierId" = ${cashierId}` : Prisma.empty}
      GROUP BY si."productId", si."productName"
      ORDER BY amount DESC
      LIMIT ${limit}
    `);
  }

  /** First completed sale of the window for a cashier (shift start proxy). */
  async firstSaleAt(tenantId: string, cashierId: string, from: Date): Promise<Date | null> {
    const sale = await this.prisma.sale.findFirst({
      where: { tenantId, cashierId, status: COMPLETED, completedAt: { gte: from } },
      orderBy: { completedAt: 'asc' },
      select: { completedAt: true },
    });
    return sale?.completedAt ?? null;
  }

  /** Refunds paid out today (tenant-wide; refunds aren't cashier-attributed). */
  async refundsSince(tenantId: string, from: Date): Promise<number> {
    const agg = await this.prisma.refundPayment.aggregate({
      where: { tenantId, createdAt: { gte: from } },
      _sum: { amount: true },
    });
    return Number(agg._sum.amount ?? 0);
  }

  async getStats(tenantId: string, tz: string): Promise<DashboardStats> {
    // "Today" is the shop's calendar day — midnight to midnight where the shop
    // trades, not where the server happens to run.
    const { from: startOfToday, to: endOfToday } = lastNDaysInTimeZone(1, tz);

    const [todayAgg, productsCached, pendingSyncs, receivable, inventoryRows] = await Promise.all([
      this.prisma.sale.aggregate({
        where: {
          tenantId,
          status: 'COMPLETED',
          completedAt: { gte: startOfToday, lt: endOfToday },
        },
        _sum: { total: true },
        _count: { _all: true },
      }),
      this.prisma.product.count({ where: { tenantId, isActive: true } }),
      this.prisma.sale.count({
        where: { tenantId, status: 'COMPLETED', syncStatus: { not: 'SYNCED' } },
      }),
      // Receivable is a running balance, deliberately unbounded by the day
      // window above: money owed does not stop being owed at midnight.
      //
      // Asked of CreditService rather than aggregated here, so the dashboard tile,
      // the customers list and the credit-limit guard cannot drift apart — this
      // query used to be a second copy of the rule and missed account payments
      // entirely the moment credit moved to the customer.
      this.credit.totalReceivable(tenantId),
      // Column-by-column product of qty × cost needs raw SQL (no aggregate for it).
      // Items without a cost price contribute nothing rather than a fake value.
      this.prisma.$queryRaw<Array<{ value: number; stocked: number }>>`
        SELECT
          COALESCE(SUM("quantityOnHand" * COALESCE("costPrice", 0)), 0)::float AS value,
          COUNT(*) FILTER (WHERE "quantityOnHand" > 0)::int AS stocked
        FROM "Product"
        WHERE "tenantId" = ${tenantId} AND "isActive" = true AND "type" = 'Inventory'`,
    ]);

    return {
      todaySalesTotal: Number(todayAgg._sum.total ?? 0),
      todayTransactions: todayAgg._count._all,
      productsCached,
      pendingSyncs,
      outstandingReceivable: receivable,
      inventoryValue: Number(inventoryRows[0]?.value ?? 0),
      stockedProducts: Number(inventoryRows[0]?.stocked ?? 0),
    };
  }
}
