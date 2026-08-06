import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PaymentMethod, PaymentStatus, Prisma } from '@hardware-pos/database';

import { PrismaService } from '../../prisma/prisma.service';
import { BillSplitInputDto, CollectPaymentDto } from './dto/billing.dto';

export interface BillView {
  saleId: string;
  saleNumber: string;
  subtotal: string;
  serviceChargeAmount: string;
  packagingCharge: string;
  total: string;
  paidAmount: string;
  balanceAmount: string;
  paymentStatus: PaymentStatus;
  splits: { id: string; label: string | null; share: string; paidAmount: string }[];
  payments: {
    id: string;
    amount: string;
    method: PaymentMethod;
    reference: string | null;
  }[];
}

@Injectable()
export class BillingService {
  constructor(private readonly prisma: PrismaService) {}

  async getBill(tenantId: string, saleId: string): Promise<BillView> {
    const sale = await this.prisma.sale.findFirst({
      where: { id: saleId, tenantId },
      include: {
        billSplits: { orderBy: { createdAt: 'asc' } },
        payments: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!sale) throw new NotFoundException('Sale not found');
    return this.toView(sale);
  }

  async collectPayment(
    tenantId: string,
    saleId: string,
    dto: CollectPaymentDto,
    actorUserId: string,
  ): Promise<BillView> {
    return this.prisma.$transaction(async (tx) => {
      const sale = await tx.sale.findFirst({
        where: { id: saleId, tenantId },
        select: { id: true, total: true, paidAmount: true, billingVersion: true },
      });
      if (!sale) throw new NotFoundException('Sale not found');

      const paymentAmount = new Prisma.Decimal(dto.amount);
      const newPaid = sale.paidAmount.plus(paymentAmount);
      if (newPaid.greaterThan(sale.total)) {
        throw new BadRequestException(
          `Payment ${paymentAmount.toFixed(2)} exceeds balance ${sale.total
            .minus(sale.paidAmount)
            .toFixed(2)}`,
        );
      }
      const newBalance = sale.total.minus(newPaid);
      const nextStatus: PaymentStatus =
        newBalance.equals(0) ? PaymentStatus.PAID : PaymentStatus.PARTIAL;

      await tx.payment.create({
        data: {
          tenantId,
          saleId: sale.id,
          receivedByUserId: actorUserId,
          method: dto.method as PaymentMethod,
          amount: paymentAmount,
          reference: dto.reference ?? null,
        },
      });
      // Two-phase update — check billingVersion to catch concurrent
      // cashiers (scenario 18: two users cannot complete the same payment).
      const updated = await tx.sale.updateMany({
        where: { id: sale.id, billingVersion: sale.billingVersion },
        data: {
          paidAmount: newPaid,
          balanceAmount: newBalance,
          paymentStatus: nextStatus,
          billingVersion: { increment: 1 },
        },
      });
      if (updated.count === 0) {
        throw new BadRequestException('Bill was modified concurrently; reload and retry');
      }
      return this.getBill(tenantId, sale.id);
    });
  }

  async setSplits(
    tenantId: string,
    saleId: string,
    splits: BillSplitInputDto[],
  ): Promise<BillView> {
    return this.prisma.$transaction(async (tx) => {
      const sale = await tx.sale.findFirst({
        where: { id: saleId, tenantId },
        select: { id: true, total: true, billingVersion: true },
      });
      if (!sale) throw new NotFoundException('Sale not found');

      const sum = splits.reduce(
        (acc, s) => acc.plus(new Prisma.Decimal(s.share)),
        new Prisma.Decimal(0),
      );
      if (!sum.equals(sale.total)) {
        throw new BadRequestException(
          `Splits sum ${sum.toFixed(2)} must equal total ${sale.total.toFixed(2)}`,
        );
      }
      await tx.billSplit.deleteMany({ where: { saleId: sale.id } });
      await tx.billSplit.createMany({
        data: splits.map((s) => ({
          tenantId,
          saleId: sale.id,
          label: s.label ?? null,
          share: new Prisma.Decimal(s.share),
        })),
      });
      await tx.sale.update({
        where: { id: sale.id },
        data: { billingVersion: { increment: 1 } },
      });
      return this.getBill(tenantId, sale.id);
    });
  }

  async reopen(
    tenantId: string,
    saleId: string,
    _reason: string,
  ): Promise<BillView> {
    return this.prisma.$transaction(async (tx) => {
      const sale = await tx.sale.findFirst({
        where: { id: saleId, tenantId },
        select: { id: true, paymentStatus: true },
      });
      if (!sale) throw new NotFoundException('Sale not found');
      if (sale.paymentStatus === PaymentStatus.PAID) {
        // Reopening a fully-paid bill implies a refund path; that's out of
        // scope here. Refuse cleanly.
        throw new BadRequestException(
          'Bill is fully paid — issue a return via /returns instead',
        );
      }
      // For UNPAID/PARTIAL bills, "reopen" is a no-op state-wise; the
      // audit record from the controller captures the who/why.
      return this.getBill(tenantId, sale.id);
    });
  }

  private toView(
    sale: Prisma.SaleGetPayload<{ include: { billSplits: true; payments: true } }>,
  ): BillView {
    return {
      saleId: sale.id,
      saleNumber: sale.saleNumber,
      subtotal: sale.subtotal.toFixed(2),
      serviceChargeAmount: sale.serviceChargeAmount.toFixed(2),
      packagingCharge: sale.packagingCharge.toFixed(2),
      total: sale.total.toFixed(2),
      paidAmount: sale.paidAmount.toFixed(2),
      balanceAmount: sale.balanceAmount.toFixed(2),
      paymentStatus: sale.paymentStatus,
      splits: sale.billSplits.map((s) => ({
        id: s.id,
        label: s.label,
        share: s.share.toFixed(2),
        paidAmount: s.paidAmount.toFixed(2),
      })),
      payments: sale.payments.map((p) => ({
        id: p.id,
        amount: p.amount.toFixed(2),
        method: p.method,
        reference: p.reference ?? null,
      })),
    };
  }
}
