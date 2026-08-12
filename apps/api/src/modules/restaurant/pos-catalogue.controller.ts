import { Controller, Get, Query } from '@nestjs/common';
import { IsIn, IsOptional, IsString } from 'class-validator';
import { ModuleKey } from '@hardware-pos/database';

import { RequireModule } from '../../common/decorators/require-module.decorator';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { Permission } from '../auth/permissions';
import {
  PosCatalogueResponse,
  PosCatalogueService,
} from './pos-catalogue.service';

/**
 * D45 — Read model for the Restaurant POS counter.
 *
 * Gated on `RETAIL_POS` because the Restaurant POS counter runs on top of it —
 * the same guard that today allows the RETAIL POS to render for a Restaurant
 * tenant. Kept on a Restaurant path (`/restaurant/pos-catalogue`) so it is
 * obvious the payload is shaped for the Restaurant counter's per-branch grid
 * rather than the Retail search-bar workflow.
 */
export class QueryPosCatalogueDto {
  @IsString()
  branchId!: string;

  @IsOptional()
  @IsIn(['DINE_IN', 'TAKEAWAY', 'ONLINE'])
  channel?: 'DINE_IN' | 'TAKEAWAY' | 'ONLINE';

  @IsOptional()
  @IsIn(['FOOD', 'BEVERAGE', 'DESSERT'])
  foodType?: 'FOOD' | 'BEVERAGE' | 'DESSERT';

  @IsOptional()
  @IsString()
  search?: string;
}

@Controller('restaurant/pos-catalogue')
// D45 hotfix — the Restaurant Counter POS reads this endpoint. `RETAIL_POS`
// was the initial guess but Restaurant tenants don't have it in their
// default module set. `MENU_MANAGEMENT` is the module that governs
// Restaurant catalogue access and is present on every Restaurant tenant.
@RequireModule(ModuleKey.MENU_MANAGEMENT)
export class PosCatalogueController {
  constructor(private readonly service: PosCatalogueService) {}

  @Get()
  @RequirePermissions(Permission.PRODUCT_READ)
  list(
    @TenantId() tenantId: string,
    @Query() query: QueryPosCatalogueDto,
  ): Promise<PosCatalogueResponse> {
    return this.service.list(tenantId, {
      branchId: query.branchId,
      channel: query.channel,
      foodType: query.foodType,
      search: query.search,
    });
  }
}
