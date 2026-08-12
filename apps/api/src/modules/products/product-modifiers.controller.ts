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
import {
  ProductModifierGroupView,
  ProductModifiersService,
} from './product-modifiers.service';

/**
 * D45 — Product ↔ ModifierGroup attachment endpoints.
 *
 * The wizard's modifier step fetches the tenant's group catalogue from the
 * existing `/restaurant/modifier-groups` endpoints (owned by `MenuModule`) and
 * then attaches / reorders them per-product here. The junction lives on the
 * Product side, so its endpoints hang off `/products/:productId` where the
 * matching variants and stations already sit.
 */
export class ReplaceModifierGroupsDto {
  @IsArray()
  @IsString({ each: true })
  modifierGroupIds!: string[];
}

@Controller('products/:productId/modifier-groups')
export class ProductModifiersController {
  constructor(
    private readonly service: ProductModifiersService,
    private readonly audit: AuditLogService,
  ) {}

  @Get()
  @RequirePermissions(Permission.PRODUCT_READ)
  list(
    @TenantId() tenantId: string,
    @Param('productId') productId: string,
  ): Promise<{ modifierGroups: ProductModifierGroupView[] }> {
    return this.service
      .list(tenantId, productId)
      .then((modifierGroups) => ({ modifierGroups }));
  }

  @Put()
  @RequirePermissions(Permission.PRODUCT_MANAGE)
  async replace(
    @TenantId() tenantId: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Param('productId') productId: string,
    @Body() dto: ReplaceModifierGroupsDto,
  ): Promise<{ modifierGroups: ProductModifierGroupView[] }> {
    const modifierGroups = await this.service.replace(
      tenantId,
      productId,
      dto.modifierGroupIds,
    );
    await this.audit.record(tenantId, {
      userId: actor.id,
      action: 'PRODUCT_MODIFIER_GROUPS_UPDATED',
      entityType: 'Product',
      entityId: productId,
      metadata: {
        modifierGroupIds: dto.modifierGroupIds,
        count: dto.modifierGroupIds.length,
      },
    });
    return { modifierGroups };
  }
}
