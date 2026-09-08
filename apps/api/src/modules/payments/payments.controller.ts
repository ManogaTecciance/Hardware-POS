import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { Payment } from '@hardware-pos/database';

import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { Permission } from '../auth/permissions';
import { AuthenticatedUser } from '../auth/auth.types';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { AccountPaymentResult, PaymentsService } from './payments.service';

@Controller('payments')
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  /**
   * Payments for one sale (money tendered at the till) or one customer (their
   * credit account history). One of the two is required — without a filter this
   * would return every payment in the tenant.
   */
  @Get()
  @RequirePermissions(Permission.SALE_READ)
  list(
    @TenantId() tenantId: string,
    @Query('saleId') saleId?: string,
    @Query('customerId') customerId?: string,
  ): Promise<Payment[]> {
    return this.paymentsService.list(tenantId, { saleId, customerId });
  }

  @Get(':id')
  @RequirePermissions(Permission.SALE_READ)
  getById(@TenantId() tenantId: string, @Param('id') id: string): Promise<Payment> {
    return this.paymentsService.getById(tenantId, id);
  }

  /** Record a payment received against a customer's credit account. */
  @Post()
  @RequirePermissions(Permission.PAYMENT_CREATE)
  create(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreatePaymentDto,
  ): Promise<AccountPaymentResult> {
    return this.paymentsService.create(tenantId, user, dto);
  }
}
