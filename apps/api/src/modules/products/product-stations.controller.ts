import {
  Body,
  Controller,
  Get,
  Param,
  Put,
} from '@nestjs/common';
import { IsArray, IsString } from 'class-validator';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AuthenticatedUser } from '../auth/auth.types';
import { Permission } from '../auth/permissions';
import { ProductStationView, ProductStationsService } from './product-stations.service';

/**
 * D45 — Product ↔ KitchenStation attachment endpoints.
 *
 * The KitchenStation catalogue itself is owned by
 * `restaurant/branches/:branchId/kitchen-stations`; here we only attach or
 * detach existing stations from a Product. Attachments cross branch: a Product
 * may point at stations in multiple branches so KOT routing can pick the right
 * one for the branch a round belongs to.
 */
export class ReplaceStationsDto {
  @IsArray()
  @IsString({ each: true })
  stationIds!: string[];
}

@Controller('products/:productId/kitchen-stations')
export class ProductStationsController {
  constructor(
    private readonly service: ProductStationsService,
    private readonly audit: AuditLogService,
  ) {}

  @Get()
  @RequirePermissions(Permission.PRODUCT_READ)
  list(
    @TenantId() tenantId: string,
    @Param('productId') productId: string,
  ): Promise<{ stations: ProductStationView[] }> {
    return this.service.list(tenantId, productId).then((stations) => ({ stations }));
  }

  @Put()
  @RequirePermissions(Permission.PRODUCT_MANAGE)
  async replace(
    @TenantId() tenantId: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Param('productId') productId: string,
    @Body() dto: ReplaceStationsDto,
  ): Promise<{ stations: ProductStationView[] }> {
    const stations = await this.service.replace(tenantId, productId, dto.stationIds);
    await this.audit.record(tenantId, {
      userId: actor.id,
      action: 'PRODUCT_STATIONS_UPDATED',
      entityType: 'Product',
      entityId: productId,
      metadata: { stationIds: dto.stationIds, count: dto.stationIds.length },
    });
    return { stations };
  }
}
