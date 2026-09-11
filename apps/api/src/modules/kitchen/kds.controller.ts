import { Controller, Get, Param, Query } from '@nestjs/common';
import { KitchenTicketStatus, ModuleKey } from '@hardware-pos/database';

import { RequireModule } from '../../common/decorators/require-module.decorator';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { Permission } from '../auth/permissions';
import { QueryKitchenTicketsDto } from './dto/kitchen.dto';
import { KitchenService, type KitchenTicketListView } from './kitchen.service';

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
  async board(
    @TenantId() tenantId: string,
    @Param('branchId') branchId: string,
    @Query() query: QueryKitchenTicketsDto,
  ): Promise<KitchenTicketListView> {
    /*
     * D68 — default to OUTSTANDING, not QUEUED. A ticket left on one of the
     * retired print statuses by a pre-D68 round is still food nobody has
     * cooked; filtering on QUEUED alone would hide it from the pass.
     */
    const { status } = query;
    const filter =
      status && status in KitchenTicketStatus ? (status as KitchenTicketStatus) : 'OUTSTANDING';
    /*
     * D154 — the same envelope the kitchen board's route answers with.
     *
     * The first cut of this kept the bare array, on the reasoning that this
     * route has no lane chips and nothing reading it should change for a fix
     * aimed elsewhere. That left two routes serving ONE service read in two
     * shapes with no test pinning the difference on purpose, and it made this
     * route pay for three counts it threw away. Nothing consumes `/kds/board`
     * today — its client exists but is called nowhere — so the divergence
     * bought nobody anything and cost the next reader a puzzle.
     *
     * One read, one shape. A KDS that wants only the cards reads `items` and
     * ignores the rest, exactly as the board did before it had chips.
     *
     * D174 — and the same optional `?stationId=`, for the same reason: this
     * route IS the list read, and a station screen driven off it would want
     * its own slice and its own numbers rather than the branch's.
     */
    return this.kitchen.listTicketsForBranch(tenantId, branchId, filter, query.stationId);
  }
}
