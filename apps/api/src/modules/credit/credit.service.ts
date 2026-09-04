import { Injectable } from '@nestjs/common';
import { Prisma } from '@hardware-pos/database';

import { round2 } from '../../common/money';
import { PrismaService } from '../../prisma/prisma.service';

/** What a customer owes, and what that leaves them able to take on credit. */
export interface CustomerCredit {
  creditAllowed: boolean;
  /** null = no limit configured. Not the same as a limit of zero. */
  creditLimit: number | null;
  /** Total unpaid balance across the customer's completed, unsettled sales. */
  outstanding: number;
  /** `creditLimit - outstanding`, or null when there is no limit to measure against. */
  available: number | null;
}

/**
 * A sale counts against a customer's credit while it is completed and still
 * owing. A draft has not happened yet, and a settled sale has been paid for.
 */
const OWING: Prisma.SaleWhereInput = {
  status: 'COMPLETED',
  paymentStatus: { in: ['UNPAID', 'PARTIAL'] },
};

/**
 * The one place that answers "how much does this customer owe, and how much
 * credit is left".
 *
 * It exists because the same number is needed in three places that must agree:
 * the guard that refuses an over-limit sale, the figure shown on the customers
 * list, and the receivables total on the dashboard. Computed from the sales
 * themselves rather than a running balance on the customer, so it cannot drift
 * out of step with the sales it is derived from — recording a payment or
 * settling a sale moves it with no extra bookkeeping.
 */
@Injectable()
export class CreditService {
  constructor(private readonly prisma: PrismaService) {}

  /** Prisma filter selecting customers who currently owe something. */
  static readonly HAS_OUTSTANDING: Prisma.CustomerWhereInput = {
    sales: { some: { ...OWING, balanceAmount: { gt: 0 } } },
  };

  /** Credit position for one customer, or null when the customer does not exist. */
  async forCustomer(tenantId: string, customerId: string): Promise<CustomerCredit | null> {
    const customer = await this.prisma.customer.findFirst({
      where: { id: customerId, tenantId },
      select: { creditAllowed: true, creditLimit: true },
    });
    if (!customer) return null;

    const agg = await this.prisma.sale.aggregate({
      where: { tenantId, customerId, ...OWING },
      _sum: { balanceAmount: true },
    });

    const creditLimit = customer.creditLimit != null ? Number(customer.creditLimit) : null;
    const outstanding = round2(Number(agg._sum.balanceAmount ?? 0));
    return {
      creditAllowed: customer.creditAllowed,
      creditLimit,
      outstanding,
      available: creditLimit != null ? round2(creditLimit - outstanding) : null,
    };
  }

  /**
   * Outstanding balance for many customers at once, keyed by customer id.
   *
   * One grouped query for the whole page rather than one per row — the customers
   * list would otherwise issue an aggregate per customer on every page load.
   * Customers who owe nothing are simply absent from the map.
   */
  async outstandingByCustomer(
    tenantId: string,
    customerIds: string[],
  ): Promise<Map<string, number>> {
    if (customerIds.length === 0) return new Map();
    const rows = await this.prisma.sale.groupBy({
      by: ['customerId'],
      where: { tenantId, customerId: { in: customerIds }, ...OWING },
      _sum: { balanceAmount: true },
    });
    return new Map(
      rows
        .filter((r): r is typeof r & { customerId: string } => r.customerId !== null)
        .map((r) => [r.customerId, round2(Number(r._sum.balanceAmount ?? 0))]),
    );
  }

  /**
   * Everything the shop is currently owed, across every customer.
   *
   * Includes sales with no customer attached: a walk-in cannot take credit today,
   * but if one ever carries a balance it is still money owed, and a receivables
   * figure that quietly omits it would be wrong.
   */
  async totalReceivable(tenantId: string): Promise<number> {
    const agg = await this.prisma.sale.aggregate({
      where: { tenantId, ...OWING },
      _sum: { balanceAmount: true },
    });
    return round2(Number(agg._sum.balanceAmount ?? 0));
  }
}
