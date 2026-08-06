import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ModuleKey, Payment } from '@hardware-pos/database';

import { RequireModule } from '../../common/decorators/require-module.decorator';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { Permission } from '../auth/permissions';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { PaymentsService } from './payments.service';

// Phase 1.5.9 — payments are gated the same way as receipts; both live on the
// retail sale path.
@Controller('payments')
@RequireModule(ModuleKey.RETAIL_POS)
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Get()
  listBySale(
    @TenantId() tenantId: string,
    @Query('saleId') saleId: string,
  ): Promise<Payment[]> {
    return this.paymentsService.listBySale(tenantId, saleId);
  }

  @Get(':id')
  getById(@TenantId() tenantId: string, @Param('id') id: string): Promise<Payment> {
    return this.paymentsService.getById(tenantId, id);
  }

  @Post()
  @RequirePermissions(Permission.PAYMENT_CREATE)
  create(@TenantId() tenantId: string, @Body() dto: CreatePaymentDto): Promise<Payment> {
    return this.paymentsService.create(tenantId, dto);
  }
}
