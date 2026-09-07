import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Payment, PaymentMethod } from '@hardware-pos/database';

import { round2 } from '../../common/money';

import { CreditService } from '../credit/credit.service';
import { PrismaService } from '../../prisma/prisma.service';

/** What an account settlement did, for the caller to report back. */
export interface AccountPaymentResult {
  payment: Payment;
  /** The account balance after this payment. */
  outstanding: number;
  /** How many invoices this payment cleared, if it closed the account. */
  salesSettled: number;
}

@Injectable()
export class PaymentsRepository {
  constructor(private readonly prisma: PrismaService) {}

  findBySale(tenantId: string, saleId: string): Promise<Payment[]> {
    return this.prisma.payment.findMany({
      where: { tenantId, saleId },
      orderBy: { createdAt: 'asc' },
    });
  }

  /** A customer's account payments, newest first — the credit history table. */
  findByCustomer(tenantId: string, customerId: string): Promise<Payment[]> {
    return this.prisma.payment.findMany({
      where: { tenantId, customerId },
      orderBy: { createdAt: 'desc' },
    });
  }

  findByIdForTenant(tenantId: string, id: string): Promise<Payment | null> {
    return this.prisma.payment.findFirst({ where: { id, tenantId } });
  }

  /**
   * Record a payment received against a customer's credit account.
   *
   * Credit is settled per ACCOUNT, not per invoice: the money is not attached to
   * any one sale, and a part payment leaves every invoice outstanding. Only when
   * the account reaches zero are the invoices it covered marked as settled — all
   * of them, together, and only the ones outstanding at that moment. A sale rung
   * up afterwards starts the next balance.
   *
   * Everything happens in one transaction, and the balance is recomputed INSIDE
   * it: two people settling the same account at once would otherwise both
   * validate against the same stale figure and between them overpay it.
   */
  async recordForCustomer(input: {
    tenantId: string;
    customerId: string;
    receivedByUserId: string;
    amount: number;
    method: PaymentMethod;
    reference?: string | null;
  }): Promise<AccountPaymentResult> {
    const { tenantId, customerId } = input;
    const amount = round2(input.amount);

    return this.prisma.$transaction(async (tx) => {
      const customer = await tx.customer.findFirst({
        where: { id: customerId, tenantId },
        select: { id: true },
      });
      if (!customer) {
        throw new NotFoundException(`Customer ${customerId} not found`);
      }

      const owed = await tx.sale.aggregate({
        where: CreditService.owingSalesFor(tenantId, customerId),
        _sum: { balanceAmount: true },
      });
      const alreadyPaid = await tx.payment.aggregate({
        where: CreditService.unsettledPaymentsFor(tenantId, customerId),
        _sum: { amount: true },
      });

      const outstandingBefore = round2(
        Number(owed._sum.balanceAmount ?? 0) - Number(alreadyPaid._sum.amount ?? 0),
      );
      if (outstandingBefore <= 0) {
        throw new BadRequestException('This customer has nothing outstanding on their account');
      }
      if (amount > outstandingBefore) {
        throw new BadRequestException(
          `Payment of ${amount.toFixed(2)} exceeds the ${outstandingBefore.toFixed(2)} outstanding on this account`,
        );
      }

      const payment = await tx.payment.create({
        data: {
          tenantId,
          customerId,
          saleId: null,
          receivedByUserId: input.receivedByUserId,
          amount,
          method: input.method,
          reference: input.reference ?? null,
          syncStatus: 'NOT_SYNCED',
        },
      });

      const outstanding = round2(outstandingBefore - amount);
      if (outstanding > 0) {
        // Still owing: nothing is marked paid. Every invoice stays on credit
        // until the account itself is clear — that is the whole rule.
        return { payment, outstanding, salesSettled: 0 };
      }

      // Cleared. Cover every invoice outstanding AT THIS MOMENT, and retire the
      // payments that did it so the next balance starts from zero rather than
      // carrying this money forward against it.
      const settledAt = new Date();
      const owing = CreditService.owingSalesFor(tenantId, customerId);

      // Anything still waiting to be accounted for is accounted for by this
      // payment: the invoices that had a Mark paid button are stamped with the
      // moment the account came square and the person who took the money, so the
      // customer page reads the same whether a user ticked an invoice off or the
      // payment did it for them.
      const sweptUnmarked = await tx.sale.updateMany({
        where: { ...owing, markedPaidAt: null },
        data: {
          creditSettledAt: settledAt,
          markedPaidAt: settledAt,
          markedPaidByUserId: input.receivedByUserId,
        },
      });

      // An invoice someone already ticked off keeps their name and their
      // timestamp — they accounted for it, and this payment does not rewrite that.
      const sweptMarked = await tx.sale.updateMany({
        where: owing,
        data: { creditSettledAt: settledAt },
      });

      await tx.payment.updateMany({
        where: CreditService.unsettledPaymentsFor(tenantId, customerId),
        data: { settledAt },
      });

      return {
        payment,
        outstanding: 0,
        salesSettled: sweptUnmarked.count + sweptMarked.count,
      };
    });
  }
}
