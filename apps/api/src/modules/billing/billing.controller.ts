import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ModuleKey } from '@hardware-pos/database';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequireModule } from '../../common/decorators/require-module.decorator';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AuthenticatedUser } from '../auth/auth.types';
import { Permission } from '../auth/permissions';
import {
  CollectPaymentDto,
  CreateSplitsDto,
  ReopenBillDto,
} from './dto/billing.dto';
import { BillView, BillingService } from './billing.service';

// Phase 8: restaurant billing operations on top of the Sale that a closed
// session produces. Gated by TABLE_MANAGEMENT (billing belongs to the
// service tier), permissions per operation.
@Controller('restaurant/bills')
@RequireModule(ModuleKey.TABLE_MANAGEMENT)
export class BillingController {
  constructor(
    private readonly service: BillingService,
    private readonly audit: AuditLogService,
  ) {}

  @Get(':saleId')
  @RequirePermissions(Permission.BILL_VIEW)
  get(@TenantId() tenantId: string, @Param('saleId') saleId: string): Promise<BillView> {
    return this.service.getBill(tenantId, saleId);
  }

  @Post(':saleId/payments')
  @RequirePermissions(Permission.PAYMENT_COLLECT)
  async collect(
    @TenantId() tenantId: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Param('saleId') saleId: string,
    @Body() dto: CollectPaymentDto,
  ): Promise<BillView> {
    const updated = await this.service.collectPayment(tenantId, saleId, dto, actor.id);
    await this.audit.record(tenantId, {
      userId: actor.id,
      action: 'BILL_PAYMENT_COLLECTED',
      entityType: 'Sale',
      entityId: saleId,
      metadata: {
        amount: dto.amount,
        method: dto.method,
        reference: dto.reference,
        newPaymentStatus: updated.paymentStatus,
      },
    });
    return updated;
  }

  @Post(':saleId/splits')
  @RequirePermissions(Permission.BILL_SPLIT)
  async setSplits(
    @TenantId() tenantId: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Param('saleId') saleId: string,
    @Body() dto: CreateSplitsDto,
  ): Promise<BillView> {
    const updated = await this.service.setSplits(tenantId, saleId, dto.splits);
    await this.audit.record(tenantId, {
      userId: actor.id,
      action: 'BILL_SPLIT_APPLIED',
      entityType: 'Sale',
      entityId: saleId,
      metadata: { splitCount: dto.splits.length },
    });
    return updated;
  }

  @Post(':saleId/reopen')
  @RequirePermissions(Permission.BILL_SPLIT)
  async reopen(
    @TenantId() tenantId: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Param('saleId') saleId: string,
    @Body() dto: ReopenBillDto,
  ): Promise<BillView> {
    const updated = await this.service.reopen(tenantId, saleId, dto.reason);
    await this.audit.record(tenantId, {
      userId: actor.id,
      action: 'BILL_REOPENED',
      entityType: 'Sale',
      entityId: saleId,
      metadata: { reason: dto.reason },
    });
    return updated;
  }
}
