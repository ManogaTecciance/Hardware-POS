import { Controller, Get, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { KitchenTicketStatus, ModuleKey } from '@hardware-pos/database';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequireModule } from '../../common/decorators/require-module.decorator';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AuthenticatedUser } from '../auth/auth.types';
import { Permission } from '../auth/permissions';
import { KitchenService, KitchenTicketNotFoundError, KitchenTicketView } from './kitchen.service';

/**
 * D68 — the kitchen board's write surface.
 *
 * Two verbs where Phase 6 had four: read the queue, say the food is done.
 * `mark-printed`, `mark-failed` and `reprint` went with the printers — they
 * described what a device did, and there is no device.
 */
@Controller('restaurant/branches/:branchId/kitchen-tickets')
@RequireModule(ModuleKey.KITCHEN)
export class KitchenTicketsController {
  constructor(
    private readonly service: KitchenService,
    private readonly audit: AuditLogService,
  ) {}

  @Get()
  @RequirePermissions(Permission.KOT_VIEW)
  list(
    @TenantId() tenantId: string,
    @Param('branchId') branchId: string,
    @Query('status') status?: string,
  ): Promise<KitchenTicketView[]> {
    return this.service.listTicketsForBranch(tenantId, branchId, parseFilter(status));
  }

  @Post(':ticketId/complete')
  @RequirePermissions(Permission.KITCHEN_STATUS_UPDATE)
  async complete(
    @TenantId() tenantId: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Param('branchId') branchId: string,
    @Param('ticketId') ticketId: string,
  ): Promise<KitchenTicketView> {
    try {
      const updated = await this.service.completeTicket(tenantId, branchId, ticketId, actor.id);
      await this.audit.record(tenantId, {
        userId: actor.id,
        action: 'KITCHEN_TICKET_COMPLETED',
        entityType: 'KitchenTicket',
        entityId: ticketId,
        metadata: { ticketNumber: updated.ticketNumber, stationId: updated.stationId },
      });
      return updated;
    } catch (err) {
      if (err instanceof KitchenTicketNotFoundError) throw new NotFoundException(err.message);
      throw err;
    }
  }
}

/**
 * `?status=` accepts a real ticket status or the board's `OUTSTANDING`
 * pseudo-filter. Anything unrecognised means "no filter" rather than an
 * error: a stale bookmark should show the whole board, not a 400.
 */
function parseFilter(status?: string): KitchenTicketStatus | 'OUTSTANDING' | undefined {
  if (!status) return undefined;
  if (status === 'OUTSTANDING') return 'OUTSTANDING';
  return status in KitchenTicketStatus ? (status as KitchenTicketStatus) : undefined;
}
