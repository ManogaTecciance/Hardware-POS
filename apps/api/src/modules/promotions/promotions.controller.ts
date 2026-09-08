import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ModuleKey } from '@hardware-pos/database';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequireModule } from '../../common/decorators/require-module.decorator';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { AuthenticatedUser } from '../auth/auth.types';
import { Permission } from '../auth/permissions';
import { CreatePromotionDto } from './dto/create-promotion.dto';
import { QueryPromotionsDto } from './dto/query-promotions.dto';
import { UpdatePromotionDto } from './dto/update-promotion.dto';
import { PromotionView, PromotionsService } from './promotions.service';

/**
 * D45 — Promotions module. Gated on `INVENTORY` because the Promotions admin
 * UI lives under the Inventory navigation tab, and INVENTORY is the one module
 * that BOTH Restaurant and Retail tenants carry by default (Restaurant needs
 * ingredient-level stock, Retail needs on-hand for QBO parity). Restaurant-only
 * modules like MENU_MANAGEMENT would refuse Retail's later use of promotions,
 * and the discount module's RETAIL_POS gate mirrors the wrong side of the
 * split. See D45 (`docs/restaurant-pos/00-decisions.md`) for the rationale.
 */
@Controller('promotions')
// D45 hotfix — Promotion is a Restaurant admin surface introduced by D45,
// primarily attached to Restaurant products. `INVENTORY` was the initial
// guess but Restaurant tenants don't have it in their default module set —
// `MENU_MANAGEMENT` is the module that governs their catalogue admin and
// is present on every Restaurant / Cafe / Bakery tenant.
@RequireModule(ModuleKey.MENU_MANAGEMENT)
export class PromotionsController {
  constructor(private readonly service: PromotionsService) {}

  @Get()
  @RequirePermissions(Permission.PRODUCT_READ)
  list(
    @TenantId() tenantId: string,
    @Query() query: QueryPromotionsDto,
  ): Promise<{ items: PromotionView[]; total: number }> {
    // Tenant time-zone plumbing lands with the settings work — the evaluator
    // falls back to the host's local zone for now. See the evaluator's
    // comments for the drop-in point.
    return this.service.list(tenantId, query);
  }

  @Get(':id')
  @RequirePermissions(Permission.PRODUCT_READ)
  getById(
    @TenantId() tenantId: string,
    @Param('id') id: string,
  ): Promise<PromotionView> {
    return this.service.getById(tenantId, id);
  }

  @Post()
  @RequirePermissions(Permission.PRODUCT_MANAGE)
  create(
    @TenantId() tenantId: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Body() dto: CreatePromotionDto,
  ): Promise<PromotionView> {
    return this.service.create(tenantId, actor.id, dto);
  }

  @Patch(':id')
  @RequirePermissions(Permission.PRODUCT_MANAGE)
  update(
    @TenantId() tenantId: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdatePromotionDto,
  ): Promise<PromotionView> {
    return this.service.update(tenantId, actor.id, id, dto);
  }

  @Delete(':id')
  @RequirePermissions(Permission.PRODUCT_MANAGE)
  delete(
    @TenantId() tenantId: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<{ id: string }> {
    return this.service.delete(tenantId, actor.id, id);
  }

  @Post(':id/activate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.PRODUCT_MANAGE)
  activate(
    @TenantId() tenantId: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<PromotionView> {
    return this.service.setActive(tenantId, actor.id, id, true);
  }

  @Post(':id/deactivate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.PRODUCT_MANAGE)
  deactivate(
    @TenantId() tenantId: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<PromotionView> {
    return this.service.setActive(tenantId, actor.id, id, false);
  }
}
