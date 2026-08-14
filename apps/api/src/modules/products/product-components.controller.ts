import { Body, Controller, Get, Param, Put } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AuthenticatedUser } from '../auth/auth.types';
import { Permission } from '../auth/permissions';
import {
  ProductComponentsService,
  ProductComponentView,
} from './product-components.service';

/**
 * D65 — a product's recipe / component list (convergence plan §8.8).
 *
 * Hangs off `/products/:productId` beside the variant, modifier and station
 * endpoints. Replace-all PUT, wizard-owned. Server authority on the
 * capability lives in the service; the routes themselves stay SHARED_CORE
 * like the rest of the product surface.
 */
export class ProductComponentInputDto {
  @IsString() componentProductId!: string;
  @Type(() => Number) @IsNumber() @IsPositive() quantity!: number;
  @IsOptional() @IsString() @MaxLength(20) unit?: string;
  /** Proportional loss (0.05 = 5%). Below 1 — a recipe cannot waste it all. */
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) @Max(0.9999) wastageRate?: number;
}

export class ReplaceComponentsDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ProductComponentInputDto)
  components!: ProductComponentInputDto[];
}

@Controller('products/:productId/components')
export class ProductComponentsController {
  constructor(
    private readonly service: ProductComponentsService,
    private readonly audit: AuditLogService,
  ) {}

  @Get()
  @RequirePermissions(Permission.PRODUCT_READ)
  list(
    @TenantId() tenantId: string,
    @Param('productId') productId: string,
  ): Promise<{ components: ProductComponentView[] }> {
    return this.service.list(tenantId, productId).then((components) => ({ components }));
  }

  @Put()
  @RequirePermissions(Permission.PRODUCT_MANAGE)
  async replace(
    @TenantId() tenantId: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Param('productId') productId: string,
    @Body() dto: ReplaceComponentsDto,
  ): Promise<{ components: ProductComponentView[] }> {
    const components = await this.service.replace(tenantId, productId, dto.components);
    await this.audit.record(tenantId, {
      userId: actor.id,
      action: 'PRODUCT_COMPONENTS_UPDATED',
      entityType: 'Product',
      entityId: productId,
      metadata: {
        componentProductIds: dto.components.map((c) => c.componentProductId),
        count: dto.components.length,
      },
    });
    return { components };
  }
}
