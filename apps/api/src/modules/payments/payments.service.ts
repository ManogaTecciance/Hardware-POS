import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Payment } from '@hardware-pos/database';

import { AuthenticatedUser } from '../auth/auth.types';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { PaymentsRepository } from './payments.repository';

export type { AccountPaymentResult } from './payments.repository';
import type { AccountPaymentResult } from './payments.repository';

@Injectable()
export class PaymentsService {
  constructor(private readonly paymentsRepository: PaymentsRepository) {}

  /**
   * Payments for one sale or one customer. A filter is required: without one
   * this would hand back every payment in the tenant.
   */
  list(
    tenantId: string,
    filter: { saleId?: string; customerId?: string },
  ): Promise<Payment[]> {
    if (filter.saleId) return this.paymentsRepository.findBySale(tenantId, filter.saleId);
    if (filter.customerId)
      return this.paymentsRepository.findByCustomer(tenantId, filter.customerId);
    throw new BadRequestException('Provide either saleId or customerId');
  }

  async getById(tenantId: string, id: string): Promise<Payment> {
    const payment = await this.paymentsRepository.findByIdForTenant(tenantId, id);
    if (!payment) {
      throw new NotFoundException(`Payment ${id} not found`);
    }
    return payment;
  }

  /**
   * Record a payment received against a customer's credit account.
   *
   * Credit is an account balance, not a per-invoice one: the money is not
   * applied to any single sale. While anything is still owed, every credit sale
   * stays outstanding; the moment the account reaches zero, the invoices it
   * covered are marked settled together — see `recordForCustomer`.
   *
   * TODO(accountant): push the payment to QuickBooks against the customer's open
   * invoices. Until then QuickBooks continues to show them unpaid after the
   * customer has settled with the shop.
   */
  async create(
    tenantId: string,
    actor: AuthenticatedUser,
    dto: CreatePaymentDto,
  ): Promise<AccountPaymentResult> {
    if (dto.amount <= 0) {
      throw new BadRequestException('A payment must be greater than zero');
    }
    return this.paymentsRepository.recordForCustomer({
      tenantId,
      customerId: dto.customerId,
      receivedByUserId: actor.id,
      amount: dto.amount,
      method: dto.method,
      reference: dto.reference,
    });
  }
}
