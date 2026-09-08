import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ModuleKey } from '@hardware-pos/database';

import { BranchScope, BranchScopeKind } from '../../common/decorators/branch-scope.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequireModule } from '../../common/decorators/require-module.decorator';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AuthenticatedUser } from '../auth/auth.types';
import { Permission } from '../auth/permissions';
import {
  CreateReservationDto,
  SetReservationStatusDto,
  UpdateReservationDto,
} from './dto/reservations.dto';
import { ReservationsService, ReservationView } from './reservations.service';

@Controller('restaurant')
@RequireModule(ModuleKey.RESERVATIONS)
export class ReservationsController {
  constructor(
    private readonly service: ReservationsService,
    private readonly audit: AuditLogService,
  ) {}

  /**
   * Everything intersecting `[from, to)` — the Calendar's day window. The
   * client supplies explicit instants; the server never guesses a display
   * timezone (D47).
   */
  @Get('branches/:branchId/reservations')
  @RequirePermissions(Permission.RESERVATION_VIEW)
  @BranchScope(BranchScopeKind.BRANCH_SCOPED)
  list(
    @TenantId() tenantId: string,
    @Param('branchId') branchId: string,
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('includeClosed') includeClosed?: string,
  ): Promise<ReservationView[]> {
    return this.service.list(tenantId, branchId, new Date(from), new Date(to), includeClosed === 'true');
  }

  @Post('branches/:branchId/reservations')
  @RequirePermissions(Permission.RESERVATION_CREATE)
  @BranchScope(BranchScopeKind.BRANCH_SCOPED)
  async create(
    @TenantId() tenantId: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Param('branchId') branchId: string,
    @Body() dto: CreateReservationDto,
  ): Promise<ReservationView> {
    const created = await this.service.create(tenantId, branchId, actor.id, dto);
    await this.audit.record(tenantId, {
      userId: actor.id,
      action: 'RESERVATION_CREATED',
      entityType: 'TableReservation',
      entityId: created.id,
      metadata: {
        branchId,
        reservationNumber: created.reservationNumber,
        tableId: created.tableId,
        startAt: created.startAt.toISOString(),
        endAt: created.endAt.toISOString(),
        partySize: created.partySize,
      },
    });
    return created;
  }

  @Patch('reservations/:reservationId')
  @RequirePermissions(Permission.RESERVATION_MANAGE)
  async update(
    @TenantId() tenantId: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Param('reservationId') reservationId: string,
    @Body() dto: UpdateReservationDto,
  ): Promise<ReservationView> {
    const updated = await this.service.update(tenantId, reservationId, dto);
    await this.audit.record(tenantId, {
      userId: actor.id,
      action: 'RESERVATION_UPDATED',
      entityType: 'TableReservation',
      entityId: updated.id,
      metadata: {
        reservationNumber: updated.reservationNumber,
        tableId: updated.tableId,
        startAt: updated.startAt.toISOString(),
        endAt: updated.endAt.toISOString(),
      },
    });
    return updated;
  }

  @Post('reservations/:reservationId/status')
  @RequirePermissions(Permission.RESERVATION_MANAGE)
  async setStatus(
    @TenantId() tenantId: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Param('reservationId') reservationId: string,
    @Body() dto: SetReservationStatusDto,
  ): Promise<ReservationView> {
    const updated = await this.service.setStatus(tenantId, reservationId, dto.status);
    await this.audit.record(tenantId, {
      userId: actor.id,
      action: 'RESERVATION_STATUS_CHANGED',
      entityType: 'TableReservation',
      entityId: updated.id,
      metadata: { reservationNumber: updated.reservationNumber, status: updated.status },
    });
    return updated;
  }
}
