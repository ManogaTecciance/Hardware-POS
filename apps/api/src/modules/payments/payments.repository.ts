import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Payment, PaymentMethod } from '@hardware-pos/database';

import { round2 } from '../../common/money';

import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class PaymentsRepository {
  constructor(private readonly prisma: PrismaService) {}

  findBySale(tenantId: string, saleId: string): Promise<Payment[]> {
    return this.prisma.payment.findMany({
      where: { tenantId, saleId },
      orderBy: { createdAt: 'asc' },
    });
  }

  findByIdForTenant(tenantId: string, id: string): Promise<Payment | null> {
    return this.prisma.payment.findFirst({ where: { id, tenantId } });
  }

  /**
   * Record a payment against a completed sale and move the sale's balance with it.
   *
   * Done in one transaction, and the balance is re-read INSIDE it: two people
   * settling the same sale at once would otherwise both validate against the same
   * stale balance and between them overpay it. The status follows the balance —
   * PAID only when nothing is left, PARTIAL while some is.
   */
  async recordAgainstSale(input: {
    tenantId: string;
    saleId: string;
    receivedByUserId: string;
    amount: number;
    method: PaymentMethod;
    reference?: string | null;
  }): Promise<Payment> {
    return this.prisma.$transaction(async (tx) => {
      const sale = await tx.sale.findFirst({
        where: { id: input.saleId, tenantId: input.tenantId },
        select: { id: true, status: true, total: true, paidAmount: true },
      });
      if (!sale) {
        throw new NotFoundException(`Sale ${input.saleId} not found`);
      }
      if (sale.status !== 'COMPLETED') {
        throw new BadRequestException('Payments can only be recorded against a completed sale');
      }

      const total = Number(sale.total);
      const paid = Number(sale.paidAmount);
      const outstanding = round2(total - paid);
      if (outstanding <= 0) {
        throw new BadRequestException('This sale is already fully paid');
      }
      if (round2(input.amount) > outstanding) {
        throw new BadRequestException(
          `Payment of ${input.amount.toFixed(2)} exceeds the outstanding balance of ${outstanding.toFixed(2)}`,
        );
      }

      const payment = await tx.payment.create({
        data: {
          tenantId: input.tenantId,
          saleId: input.saleId,
          receivedByUserId: input.receivedByUserId,
          amount: input.amount,
          method: input.method,
          reference: input.reference ?? null,
          syncStatus: 'NOT_SYNCED',
        },
      });

      const nextPaid = round2(paid + input.amount);
      const nextBalance = round2(Math.max(0, total - nextPaid));
      await tx.sale.update({
        where: { id: input.saleId },
        data: {
          paidAmount: nextPaid,
          balanceAmount: nextBalance,
          paymentStatus: nextBalance <= 0 ? 'PAID' : 'PARTIAL',
        },
      });

      return payment;
    });
  }
}
