import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ModuleKey } from '@hardware-pos/database';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequireModule } from '../../common/decorators/require-module.decorator';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AuthenticatedUser } from '../auth/auth.types';
import { Permission } from '../auth/permissions';
import { DeliveryHubService, ExternalOrderView } from './delivery-hub.service';

// Phase 10. The webhook endpoint is authenticated but not tenant-header'd —
// each delivery platform provisions its own credentials, and the platform
// integration passes them in the URL / headers. For this internal-only
// implementation we use the standard tenant header via the guard chain and
// the standard permissions.
@Controller('delivery-hub')
@RequireModule(ModuleKey.ONLINE_ORDERS)
export class DeliveryWebhookController {
  constructor(
    private readonly service: DeliveryHubService,
    private readonly audit: AuditLogService,
  ) {}

  @Post('platforms/:platformId/webhook')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions(Permission.PLATFORM_PROFILE_MANAGE)
  async receive(
    @TenantId() tenantId: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Param('platformId') platformId: string,
    @Body() payload: unknown,
    @Headers('x-signature') _signature?: string,
  ): Promise<ExternalOrderView> {
    const result = await this.service.receiveOrder(tenantId, platformId, payload);
    await this.audit.record(tenantId, {
      userId: actor.id,
      action: 'DELIVERY_WEBHOOK_RECEIVED',
      entityType: 'ExternalOrder',
      entityId: result.id,
      metadata: {
        platformId,
        externalOrderRef: result.externalOrderRef,
      },
    });
    return result;
  }

  @Post('external-orders/:externalOrderId/accept')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.PLATFORM_PROFILE_MANAGE)
  async accept(
    @TenantId() tenantId: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Param('externalOrderId') externalOrderId: string,
  ): Promise<ExternalOrderView> {
    const result = await this.service.acceptExternal(tenantId, externalOrderId);
    await this.audit.record(tenantId, {
      userId: actor.id,
      action: 'DELIVERY_ORDER_ACCEPTED',
      entityType: 'ExternalOrder',
      entityId: externalOrderId,
      metadata: { restaurantOrderId: result.restaurantOrderId },
    });
    return result;
  }

  @Get('branches/:branchId/external-orders')
  @RequirePermissions(Permission.PLATFORM_PROFILE_READ)
  list(
    @TenantId() tenantId: string,
    @Param('branchId') branchId: string,
  ): Promise<ExternalOrderView[]> {
    return this.service.listExternalOrders(tenantId, branchId);
  }
}
