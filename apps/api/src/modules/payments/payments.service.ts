import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Payment } from '@hardware-pos/database';

import { AuthenticatedUser } from '../auth/auth.types';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { PaymentsRepository } from './payments.repository';

@Injectable()
export class PaymentsService {
  constructor(private readonly paymentsRepository: PaymentsRepository) {}

  listBySale(tenantId: string, saleId: string): Promise<Payment[]> {
    return this.paymentsRepository.findBySale(tenantId, saleId);
  }

  async getById(tenantId: string, id: string): Promise<Payment> {
    const payment = await this.paymentsRepository.findByIdForTenant(tenantId, id);
    if (!payment) {
      throw new NotFoundException(`Payment ${id} not found`);
    }
    return payment;
  }

  /**
   * Record a payment received against a credit sale.
   *
   * The sale's paid/balance amounts and payment status move with it, in the same
   * transaction — see `PaymentsRepository.recordAgainstSale`. A customer's
   * available credit needs no separate update: it is derived from the balances of
   * unsettled sales, so reducing one releases the credit automatically.
   *
   * TODO(accountant): push the payment to QuickBooks against the original
   * invoice. Until then QuickBooks continues to show the invoice as unpaid after
   * the customer has settled with the shop.
   */
  async create(tenantId: string, actor: AuthenticatedUser, dto: CreatePaymentDto): Promise<Payment> {
    if (dto.amount <= 0) {
      throw new BadRequestException('A payment must be greater than zero');
    }
    return this.paymentsRepository.recordAgainstSale({
      tenantId,
      saleId: dto.saleId,
      receivedByUserId: actor.id,
      amount: dto.amount,
      method: dto.method,
      reference: dto.reference,
    });
  }
}
