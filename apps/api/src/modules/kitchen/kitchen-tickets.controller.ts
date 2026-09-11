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
import {
  QueryKitchenHistoryDto,
  QueryKitchenLaneCountsDto,
  QueryKitchenTicketsDto,
} from './dto/kitchen.dto';
import {
  KitchenLaneCounts,
  KitchenOrderView,
  KitchenService,
  KitchenTicketListView,
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

  /**
   * D154 — one lane's tickets AND all three chips' numbers, in one request.
   *
   * The board polls this every five seconds and used to follow each tick with
   * a second call to `counts`. The envelope halves that traffic, and — the
   * part that is a fix rather than a saving — the counts come from the SAME
   * snapshot as the cards, so a ticket bumped mid-tick can no longer be on a
   * chip and off the pass at once. `counts` is the branch's whatever
   * `?status=` says (D142b).
   *
   * D174 — `?stationId=` scopes BOTH the list and the counts to one station,
   * so a board pinned to the grill reads the grill's three numbers over the
   * grill's cards. Omitted, the read is exactly what it was. The board sends
   * it on every poll rather than only when the lane changes, because the
   * counts ride along with every tick and must be the same station's each
   * time.
   */
  @Get()
  @RequirePermissions(Permission.KOT_VIEW)
  list(
    @TenantId() tenantId: string,
    @Param('branchId') branchId: string,
    @Query() query: QueryKitchenTicketsDto,
  ): Promise<KitchenTicketListView> {
    return this.service.listTicketsForBranch(
      tenantId,
      branchId,
      parseFilter(query.status),
      query.stationId,
    );
  }

  // (D115: `?status=CANCELLED` is a pseudo-filter like OUTSTANDING — see
  // parseFilter below; cancellation is order-side state, not a ticket status.)

  /**
   * D142b — what each lane chip says.
   *
   * The board reads one lane at a time, so it could only count the lane it was
   * on: "To make" and "Preparing" carried numbers while "Done" carried none,
   * and standing on Done it was the other two that went blank. Declared above
   * the `:ticketId` routes, and KOT_VIEW like every other read here.
   *
   * D154 — the BOARD stopped calling this: its counts now ride along with the
   * list. The route is unchanged and stays, because "give me only the numbers"
   * is a legitimate and much cheaper question than "give me the lane", and
   * nothing is served by making a caller who wants three integers read every
   * ticket and its items to get them.
   *
   * D174 — takes the same optional `?stationId=` as the list, and answers the
   * same three numbers the list's envelope would carry for that station, so
   * the two exposures of "the counts" cannot drift apart under a station cut.
   */
  @Get('counts')
  @RequirePermissions(Permission.KOT_VIEW)
  counts(
    @TenantId() tenantId: string,
    @Param('branchId') branchId: string,
    @Query() query: QueryKitchenLaneCountsDto,
  ): Promise<KitchenLaneCounts> {
    return this.service.laneCountsForBranch(tenantId, branchId, query.stationId);
  }

  /**
   * D142 — the kitchen's own history: every ticket this branch holds, paged
   * and searchable, today's included.
   *
   * D150 — "holds", not "has bumped". The read carried `status: COMPLETED`
   * until the PO pointed out that To make and Preparing appeared nowhere on
   * the screen; the lanes are the BOARD's split, not a division of the
   * kitchen's record.
   *
   * Declared ABOVE the `:ticketId` routes because `history` would otherwise be
   * a candidate ticket id, and KOT_VIEW like the board: this is the same
   * information the kitchen already received, read back later.
   *
   * D175 — `?stationId=` and `?tableId=`, each repeatable, are the structured
   * filters that replaced the search's station and table legs: a ticket is
   * on the page when its station is IN the one set AND its table is IN the
   * other, and an absent set is no filter on that axis. `?search=` keeps the
   * ticket number, the order number and the dish.
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
      stationIds: query.stationId,
      tableIds: query.tableId,
    });
  }

  /**
   * D83 — the whole order behind a ticket, for the board's Details view.
   *
   * KOT_VIEW, like the board: this is the same information the kitchen
   * already receives, assembled across the order's ROUNDS AND STATIONS
   * instead of one station's slice of one round. (D147 had narrowed this to
   * rounds alone, a ticket then belonging to no station; D152 put the split
   * back and the station annotation with it.)
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
       * D152 — `stationId` is recorded again here, and on complete and reopen
       * below. D147 had dropped it because every ticket cut after it belonged
       * to no station and the key would have been null forever; with the split
       * back it names the line that took the food, which is the question an
       * audit trail gets asked about a bump. Null survives only for a ticket
       * raised during the D147 window.
       */
      await this.audit.record(tenantId, {
        userId: actor.id,
        action: 'KITCHEN_TICKET_STARTED',
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
 * `?status=` accepts a real ticket status or a board pseudo-filter —
 * `OUTSTANDING` (D68), `CANCELLED` (D115, order-side cancellation) and
 * `COMPLETED_TODAY` (D142, the Done lane cut to the shop's day).
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
