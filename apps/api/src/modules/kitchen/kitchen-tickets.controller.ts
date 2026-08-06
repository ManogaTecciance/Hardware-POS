import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { KitchenTicketStatus, ModuleKey } from '@hardware-pos/database';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequireModule } from '../../common/decorators/require-module.decorator';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AuthenticatedUser } from '../auth/auth.types';
import { Permission } from '../auth/permissions';
import { MarkFailedDto, MarkPrintedDto } from './dto/kitchen.dto';
import { KitchenService, KitchenTicketView } from './kitchen.service';

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
    const s = status && (status as KitchenTicketStatus);
    return this.service.listTicketsForBranch(tenantId, branchId, s || undefined);
  }

  @Post(':ticketId/mark-printed')
  @RequirePermissions(Permission.KITCHEN_STATUS_UPDATE)
  async markPrinted(
    @TenantId() tenantId: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Param('branchId') _branchId: string,
    @Param('ticketId') ticketId: string,
    @Body() dto: MarkPrintedDto,
  ): Promise<KitchenTicketView> {
    const updated = await this.service.markPrinted(tenantId, ticketId, dto.printerId);
    await this.audit.record(tenantId, {
      userId: actor.id,
      action: 'KITCHEN_TICKET_PRINTED',
      entityType: 'KitchenTicket',
      entityId: ticketId,
      metadata: { printerId: dto.printerId },
    });
    return updated;
  }

  @Post(':ticketId/mark-failed')
  @RequirePermissions(Permission.KITCHEN_STATUS_UPDATE)
  async markFailed(
    @TenantId() tenantId: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Param('branchId') _branchId: string,
    @Param('ticketId') ticketId: string,
    @Body() dto: MarkFailedDto,
  ): Promise<KitchenTicketView> {
    const updated = await this.service.markFailed(tenantId, ticketId, dto.printerId, dto.error);
    await this.audit.record(tenantId, {
      userId: actor.id,
      action: 'KITCHEN_TICKET_ATTEMPT_FAILED',
      entityType: 'KitchenTicket',
      entityId: ticketId,
      metadata: { printerId: dto.printerId, error: dto.error },
    });
    return updated;
  }

  @Post(':ticketId/reprint')
  @RequirePermissions(Permission.KOT_PRINT)
  async reprint(
    @TenantId() tenantId: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Param('branchId') _branchId: string,
    @Param('ticketId') ticketId: string,
  ): Promise<KitchenTicketView> {
    // Reprint is a policy operation: mark the ticket as REPRINTED and let
    // the queue driver observe the flag to re-enqueue. The full re-queue
    // logic lives with the driver (not shipped here); this endpoint gives
    // the operator a clean audit trail.
    const { prisma } = this.service as unknown as { prisma: import('../../prisma/prisma.service').PrismaService };
    await prisma.kitchenTicket.updateMany({
      where: { id: ticketId, tenantId },
      data: { status: 'REPRINTED' },
    });
    const listed = await this.service.listTicketsForBranch(tenantId, _branchId);
    const found = listed.find((t) => t.id === ticketId);
    await this.audit.record(tenantId, {
      userId: actor.id,
      action: 'KITCHEN_TICKET_REPRINT_REQUESTED',
      entityType: 'KitchenTicket',
      entityId: ticketId,
      metadata: {},
    });
    return found!;
  }
}
