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
 * A sale counts against a customer's credit while it is completed, still owing,
 * and not yet covered by an account settlement. A draft has not happened yet; a
 * sale paid at the till owes nothing; and one whose customer has since cleared
 * their account has been paid for, even though no money was tendered against
 * that invoice specifically.
 */
const OWING: Prisma.SaleWhereInput = {
  status: 'COMPLETED',
  paymentStatus: { in: ['UNPAID', 'PARTIAL'] },
  creditSettledAt: null,
};

/**
 * Money received against the account and not yet consumed by a settlement.
 *
 * Once a payment has closed a balance it stops counting: leaving it in the sum
 * forever would drive every later balance negative.
 */
const UNSETTLED_ACCOUNT_PAYMENT: Prisma.PaymentWhereInput = {
  saleId: null,
  settledAt: null,
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
  // NOTE: this is a cheap "has any uncovered credit sale" test, so a customer who
  // has part-paid on account still matches. That is the intended reading — they
  // do still owe — and it stays exact because a fully-settled account has no
  // uncovered sales left at all.

  /** Credit position for one customer, or null when the customer does not exist. */
  async forCustomer(tenantId: string, customerId: string): Promise<CustomerCredit | null> {
    const customer = await this.prisma.customer.findFirst({
      where: { id: customerId, tenantId },
      select: { creditAllowed: true, creditLimit: true },
    });
    if (!customer) return null;

    const [agg, paid] = await Promise.all([
      this.prisma.sale.aggregate({
        where: { tenantId, customerId, ...OWING },
        _sum: { balanceAmount: true },
      }),
      this.prisma.payment.aggregate({
        where: { tenantId, customerId, ...UNSETTLED_ACCOUNT_PAYMENT },
        _sum: { amount: true },
      }),
    ]);

    const creditLimit = customer.creditLimit != null ? Number(customer.creditLimit) : null;
    // Invoiced-and-still-owed, less what has been paid on account but has not yet
    // cleared a balance. Never negative: over-payment is refused at the door.
    const outstanding = round2(
      Math.max(0, Number(agg._sum.balanceAmount ?? 0) - Number(paid._sum.amount ?? 0)),
    );
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
    const [owed, paid] = await Promise.all([
      this.prisma.sale.groupBy({
        by: ['customerId'],
        where: { tenantId, customerId: { in: customerIds }, ...OWING },
        _sum: { balanceAmount: true },
      }),
      this.prisma.payment.groupBy({
        by: ['customerId'],
        where: { tenantId, customerId: { in: customerIds }, ...UNSETTLED_ACCOUNT_PAYMENT },
        _sum: { amount: true },
      }),
    ]);

    const paidBy = new Map(
      paid
        .filter((r): r is typeof r & { customerId: string } => r.customerId !== null)
        .map((r) => [r.customerId, Number(r._sum.amount ?? 0)]),
    );
    return new Map(
      owed
        .filter((r): r is typeof r & { customerId: string } => r.customerId !== null)
        .map((r) => [
          r.customerId,
          round2(Math.max(0, Number(r._sum.balanceAmount ?? 0) - (paidBy.get(r.customerId) ?? 0))),
        ]),
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
    const [agg, paid] = await Promise.all([
      this.prisma.sale.aggregate({
        where: { tenantId, ...OWING },
        _sum: { balanceAmount: true },
      }),
      this.prisma.payment.aggregate({
        where: { tenantId, ...UNSETTLED_ACCOUNT_PAYMENT },
        _sum: { amount: true },
      }),
    ]);
    // Money paid on account but not yet closing a balance is money the shop has,
    // so it must come off the receivable the moment it is taken.
    return round2(
      Math.max(0, Number(agg._sum.balanceAmount ?? 0) - Number(paid._sum.amount ?? 0)),
    );
  }

  /** Filter selecting the sales an account settlement would cover. */
  static owingSalesFor(tenantId: string, customerId: string): Prisma.SaleWhereInput {
    return { tenantId, customerId, ...OWING };
  }

  /** Filter selecting the account payments a settlement would consume. */
  static unsettledPaymentsFor(tenantId: string, customerId: string): Prisma.PaymentWhereInput {
    return { tenantId, customerId, ...UNSETTLED_ACCOUNT_PAYMENT };
  }
}
