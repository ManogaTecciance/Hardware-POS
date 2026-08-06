import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ModuleKey } from '@hardware-pos/database';

import { RequireModule } from '../../common/decorators/require-module.decorator';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { Permission } from '../auth/permissions';
import { DiscountsService } from './discounts.service';
import { DiscountApprovalResult } from './discounts.types';
import { ApproveDiscountRequestDto } from './dto/approve-discount-request.dto';

// Phase 1.5.9 — discount approval is a retail POS operation. Restaurant bill
// discounting arrives in Phase 8 on its own routes.
@Controller('discounts')
@RequireModule(ModuleKey.RETAIL_POS)
export class DiscountsController {
  constructor(private readonly discountsService: DiscountsService) {}

  /**
   * A cashier submits a manager's PIN to approve a discount above their own limit.
   * Returns a short-lived approvalToken to attach to the sale line at completion.
   */
  @Post('approve')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.SALE_CREATE)
  approve(
    @TenantId() tenantId: string,
    @Body() dto: ApproveDiscountRequestDto,
  ): Promise<DiscountApprovalResult> {
    return this.discountsService.approve(tenantId, dto);
  }
}
