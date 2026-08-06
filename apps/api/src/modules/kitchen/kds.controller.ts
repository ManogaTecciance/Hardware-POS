import { Controller, Get, Param, Query } from '@nestjs/common';
import { KitchenTicketStatus, ModuleKey } from '@hardware-pos/database';

import { RequireModule } from '../../common/decorators/require-module.decorator';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { Permission } from '../auth/permissions';
import { KitchenService, KitchenTicketView } from './kitchen.service';

/**
 * Phase 13. The Kitchen Display System (KDS) board.
 *
 * A read-only surface for the kitchen. Polling today; a WebSocket push
 * is planned via `RealtimeEventBus` once the transport adapter lands.
 */
@Controller('restaurant/branches/:branchId/kds')
@RequireModule(ModuleKey.KITCHEN_DISPLAY)
export class KdsController {
  constructor(private readonly kitchen: KitchenService) {}

  @Get('board')
  @RequirePermissions(Permission.KOT_VIEW)
  board(
    @TenantId() tenantId: string,
    @Param('branchId') branchId: string,
    @Query('status') status?: string,
  ): Promise<KitchenTicketView[]> {
    // Default to QUEUED so the display shows what still needs cooking.
    const filter = (status as KitchenTicketStatus) ?? KitchenTicketStatus.QUEUED;
    return this.kitchen.listTicketsForBranch(tenantId, branchId, filter);
  }
}
