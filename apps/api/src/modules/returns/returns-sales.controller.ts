import { ModuleKey } from '@hardware-pos/database';
import { Controller, Get, Param } from '@nestjs/common';

import { RequireModule } from '../../common/decorators/require-module.decorator';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { Permission } from '../auth/permissions';
import { ReturnWithRelations } from './returns.repository';
import { ReturnsService } from './returns.service';
import { ReturnEligibility, ReturnableItem } from './returns.types';

/**
 * Sale-scoped return endpoints. Kept in the returns module (a separate controller
 * on the `sales` path) so the returns feature owns its own routes without editing
 * the sales controller.
 */
@Controller('sales')
// Slice 7.6 — return-eligibility reads live under /sales but belong to RETURNS.
@RequireModule(ModuleKey.RETURNS)
export class ReturnsSalesController {
  constructor(private readonly returnsService: ReturnsService) {}

  @Get(':id/return-eligibility')
  @RequirePermissions(Permission.RETURN_READ)
  eligibility(
    @TenantId() tenantId: string,
    @Param('id') id: string,
  ): Promise<ReturnEligibility> {
    return this.returnsService.getEligibility(tenantId, id);
  }

  @Get(':id/returnable-items')
  @RequirePermissions(Permission.RETURN_READ)
  returnableItems(
    @TenantId() tenantId: string,
    @Param('id') id: string,
  ): Promise<ReturnableItem[]> {
    return this.returnsService.getReturnableItems(tenantId, id);
  }

  /** Prior returns for a sale — powers the Sale-detail "Returns" section. */
  @Get(':id/returns')
  @RequirePermissions(Permission.RETURN_READ)
  saleReturns(
    @TenantId() tenantId: string,
    @Param('id') id: string,
  ): Promise<ReturnWithRelations[]> {
    return this.returnsService.getReturnsForSale(tenantId, id);
  }
}
