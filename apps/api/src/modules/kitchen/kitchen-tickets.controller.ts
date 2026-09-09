import { Controller, Get, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { KitchenTicketStatus, ModuleKey } from '@hardware-pos/database';

import type { Paginated } from '@hardware-pos/shared';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequireModule } from '../../common/decorators/require-module.decorator';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AuthenticatedUser } from '../auth/auth.types';
import { Permission } from '../auth/permissions';
import { QueryKitchenHistoryDto } from './dto/kitchen.dto';
import {
  KitchenLaneCounts,
  KitchenOrderView,
  KitchenService,
  KitchenTicketNotFoundError,
  KitchenTicketView,
} from './kitchen.service';

/**
 * D68 — the kitchen board's write surface.
 *
 * Say the food is done, and take it back when the bump was wrong (D100).
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

  // (D115: `?status=CANCELLED` is a pseudo-filter like OUTSTANDING — see
  // parseFilter below; cancellation is order-side state, not a ticket status.)

  /**
   * D138b — what each lane chip says.
   *
   * The board reads one lane at a time, so it could only count the lane it was
   * on: "To make" and "Preparing" carried numbers while "Done" carried none,
   * and standing on Done it was the other two that went blank. Declared above
   * the `:ticketId` routes, and KOT_VIEW like every other read here.
   */
  @Get('counts')
  @RequirePermissions(Permission.KOT_VIEW)
  counts(
    @TenantId() tenantId: string,
    @Param('branchId') branchId: string,
  ): Promise<KitchenLaneCounts> {
    return this.service.laneCountsForBranch(tenantId, branchId);
  }

  /**
   * D138 — the kitchen's own history: every ticket this branch has bumped,
   * today's included, paged and searchable.
   *
   * Declared ABOVE the `:ticketId` routes because `history` would otherwise be
   * a candidate ticket id, and KOT_VIEW like the board: this is the same
   * information the kitchen already received, read back later.
   */
  @Get('history')
  @RequirePermissions(Permission.KOT_VIEW)
  history(
    @TenantId() tenantId: string,
    @Param('branchId') branchId: string,
    @Query() query: QueryKitchenHistoryDto,
  ): Promise<Paginated<KitchenTicketView>> {
    return this.service.listHistoryForBranch(tenantId, branchId, {
      page: query.page,
      pageSize: query.pageSize,
      skip: query.skip,
      take: query.take,
      search: query.search,
    });
  }

  /**
   * D83 — the whole order behind a ticket, for the board's Details view.
   *
   * KOT_VIEW, like the board: this is the same information the kitchen
   * already receives, assembled across the order's ROUNDS instead of one
   * round at a time. (It read "across stations" until D143 made a ticket the
   * whole round; rounds are what a card is a slice of now.)
   */
  @Get(':ticketId/order')
  @RequirePermissions(Permission.KOT_VIEW)
  async order(
    @TenantId() tenantId: string,
    @Param('branchId') branchId: string,
    @Param('ticketId') ticketId: string,
  ): Promise<KitchenOrderView> {
    try {
      return await this.service.orderForTicket(tenantId, branchId, ticketId);
    } catch (err) {
      if (err instanceof KitchenTicketNotFoundError) throw new NotFoundException(err.message);
      throw err;
    }
  }

  /**
   * D113 — the cook takes the ticket: Preparing. Same permission as
   * complete; starting is the same kind of claim about the food, one step
   * earlier. The round and any takeaway profile move with it (service-side),
   * which is what puts "Preparing" on the Orders queue.
   */
  @Post(':ticketId/start')
  @RequirePermissions(Permission.KITCHEN_STATUS_UPDATE)
  async start(
    @TenantId() tenantId: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Param('branchId') branchId: string,
    @Param('ticketId') ticketId: string,
  ): Promise<KitchenTicketView> {
    try {
      const updated = await this.service.startTicket(tenantId, branchId, ticketId);
      /*
       * D143 — `stationId` is no longer recorded here (nor on complete or
       * reopen below). A ticket cut since the split was removed belongs to no
       * station, so the key would be null on every entry written from now on,
       * and a permanently-null field reads as data that went missing rather
       * than data that stopped existing. Nothing is lost for the pre-D143
       * tickets that DO carry one: `entityId` is the ticket, and the ticket
       * row still holds the station it was routed to.
       */
      await this.audit.record(tenantId, {
        userId: actor.id,
        action: 'KITCHEN_TICKET_STARTED',
        entityType: 'KitchenTicket',
        entityId: ticketId,
        metadata: { ticketNumber: updated.ticketNumber },
      });
      return updated;
    } catch (err) {
      if (err instanceof KitchenTicketNotFoundError) throw new NotFoundException(err.message);
      throw err;
    }
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
        metadata: { ticketNumber: updated.ticketNumber },
      });
      return updated;
    } catch (err) {
      if (err instanceof KitchenTicketNotFoundError) throw new NotFoundException(err.message);
      throw err;
    }
  }

  /**
   * D100 — recall. Same permission as complete: whoever may say the food is
   * done may also say it is not.
   */
  @Post(':ticketId/reopen')
  @RequirePermissions(Permission.KITCHEN_STATUS_UPDATE)
  async reopen(
    @TenantId() tenantId: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Param('branchId') branchId: string,
    @Param('ticketId') ticketId: string,
  ): Promise<KitchenTicketView> {
    try {
      const updated = await this.service.reopenTicket(tenantId, branchId, ticketId);
      await this.audit.record(tenantId, {
        userId: actor.id,
        action: 'KITCHEN_TICKET_REOPENED',
        entityType: 'KitchenTicket',
        entityId: ticketId,
        metadata: { ticketNumber: updated.ticketNumber },
      });
      return updated;
    } catch (err) {
      if (err instanceof KitchenTicketNotFoundError) throw new NotFoundException(err.message);
      throw err;
    }
  }
}

/**
 * `?status=` accepts a real ticket status or a board pseudo-filter —
 * `OUTSTANDING` (D68), `CANCELLED` (D115, order-side cancellation) and
 * `COMPLETED_TODAY` (D138, the Done lane cut to the shop's day).
 * Anything unrecognised means "no filter" rather than an error: a stale
 * bookmark should show the whole board, not a 400. Only the two pseudo-filters
 * exclude cancelled orders' tickets; a raw status (`QUEUED`, `IN_PROGRESS`,
 * …) is exactly that status, cancellation included — the board never sends
 * one, its lanes all resolve to the pseudo-filters.
 */
function parseFilter(
  status?: string,
): KitchenTicketStatus | 'OUTSTANDING' | 'CANCELLED' | 'COMPLETED_TODAY' | undefined {
  if (!status) return undefined;
  if (status === 'OUTSTANDING' || status === 'CANCELLED' || status === 'COMPLETED_TODAY') {
    return status;
  }
  return status in KitchenTicketStatus ? (status as KitchenTicketStatus) : undefined;
}
