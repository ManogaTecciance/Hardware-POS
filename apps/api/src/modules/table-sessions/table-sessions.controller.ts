import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ModuleKey, RestaurantOrderChannel } from '@hardware-pos/database';

import { BranchScope, BranchScopeKind } from '../../common/decorators/branch-scope.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequireModule } from '../../common/decorators/require-module.decorator';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AuthenticatedUser } from '../auth/auth.types';
import { Permission } from '../auth/permissions';
import {
  CloseSessionDto,
  OpenSessionDto,
  SubmitRoundDto,
  VoidItemDto,
} from './dto/table-sessions.dto';
import {
  OrderView,
  RoundView,
  TableSessionView,
  TableSessionsService,
} from './table-sessions.service';

@Controller('restaurant')
@RequireModule(ModuleKey.TABLE_MANAGEMENT)
export class TableSessionsController {
  constructor(
    private readonly service: TableSessionsService,
    private readonly audit: AuditLogService,
  ) {}

  @Post('branches/:branchId/table-sessions')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions(Permission.TABLE_OPEN)
  @BranchScope(BranchScopeKind.BRANCH_SCOPED)
  async open(
    @TenantId() tenantId: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Param('branchId') branchId: string,
    @Body() dto: OpenSessionDto,
  ): Promise<TableSessionView> {
    const session = await this.service.openSession(tenantId, branchId, dto);
    await this.audit.record(tenantId, {
      userId: actor.id,
      action: 'TABLE_SESSION_OPENED',
      entityType: 'TableSession',
      entityId: session.id,
      metadata: {
        branchId,
        tableId: dto.tableId,
        guestCount: dto.guestCount,
        sessionNumber: session.sessionNumber,
      },
    });
    return session;
  }

  @Get('table-sessions/:sessionId')
  @RequirePermissions(Permission.TABLE_VIEW)
  get(@TenantId() tenantId: string, @Param('sessionId') sessionId: string): Promise<TableSessionView> {
    return this.service.getSession(tenantId, sessionId);
  }

  @Post('table-sessions/:sessionId/orders')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions(Permission.ORDER_CREATE)
  async createOrder(
    @TenantId() tenantId: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Param('sessionId') sessionId: string,
  ): Promise<OrderView> {
    const order = await this.service.createOrder(tenantId, sessionId, RestaurantOrderChannel.DINE_IN);
    await this.audit.record(tenantId, {
      userId: actor.id,
      action: 'RESTAURANT_ORDER_CREATED',
      entityType: 'RestaurantOrder',
      entityId: order.id,
      metadata: { sessionId, orderNumber: order.orderNumber },
    });
    return order;
  }

  @Post('orders/:orderId/rounds')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions(Permission.ORDER_SEND_TO_KITCHEN)
  async submitRound(
    @TenantId() tenantId: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Param('orderId') orderId: string,
    @Body() dto: SubmitRoundDto,
  ): Promise<RoundView> {
    const round = await this.service.submitRound(tenantId, orderId, dto, actor.id);
    await this.audit.record(tenantId, {
      userId: actor.id,
      action: 'ORDER_ROUND_SUBMITTED',
      entityType: 'OrderRound',
      entityId: round.id,
      metadata: {
        orderId,
        roundNumber: round.roundNumber,
        itemCount: round.itemIds.length,
      },
    });
    return round;
  }

  @Post('order-items/:itemId/void')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions(Permission.ORDER_VOID_SENT)
  async voidItem(
    @TenantId() tenantId: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Param('itemId') itemId: string,
    @Body() dto: VoidItemDto,
  ): Promise<void> {
    await this.service.voidItem(tenantId, itemId, dto, actor.id);
    await this.audit.record(tenantId, {
      userId: actor.id,
      action: 'RESTAURANT_ORDER_ITEM_VOIDED',
      entityType: 'RestaurantOrderItem',
      entityId: itemId,
      metadata: { reason: dto.reason },
    });
  }

  @Post('table-sessions/:sessionId/close')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.TABLE_CLOSE)
  async close(
    @TenantId() tenantId: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Param('sessionId') sessionId: string,
    @Body() dto: CloseSessionDto,
  ): Promise<{ session: TableSessionView; saleId: string }> {
    const result = await this.service.closeSession(tenantId, sessionId, dto);
    await this.audit.record(tenantId, {
      userId: actor.id,
      action: 'TABLE_SESSION_CLOSED',
      entityType: 'TableSession',
      entityId: sessionId,
      metadata: { saleId: result.saleId, sessionNumber: result.session.sessionNumber },
    });
    return result;
  }
}
