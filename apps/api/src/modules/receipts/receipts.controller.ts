import { Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ModuleKey, Receipt } from '@hardware-pos/database';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequireModule } from '../../common/decorators/require-module.decorator';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { AuthenticatedUser } from '../auth/auth.types';
import { Permission } from '../auth/permissions';
import { CustomerReceiptResult, ReceiptsService } from './receipts.service';

// Phase 1.5.9 — receipts are the retail sale artefact. Every profile that
// completes a Sale can print one; a Restaurant tenant closes a table into a
// Sale (D1's junction) and will inherit this. Enforced across the class.
@Controller('receipts')
@RequireModule(ModuleKey.RETAIL_POS)
export class ReceiptsController {
  constructor(private readonly receiptsService: ReceiptsService) {}

  /** Generate the customer receipt. */
  @Post(':saleId/customer')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions(Permission.SALE_CREATE)
  customer(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('saleId') saleId: string,
  ): Promise<CustomerReceiptResult> {
    return this.receiptsService.generateCustomer(tenantId, saleId, user.id);
  }

  @Get('sale/:saleId')
  @RequirePermissions(Permission.SALE_READ)
  bySale(@TenantId() tenantId: string, @Param('saleId') saleId: string): Promise<Receipt> {
    return this.receiptsService.getReceiptBySale(tenantId, saleId);
  }

  @Get(':id')
  @RequirePermissions(Permission.SALE_READ)
  byId(@TenantId() tenantId: string, @Param('id') id: string): Promise<Receipt> {
    return this.receiptsService.getReceiptById(tenantId, id);
  }
}
