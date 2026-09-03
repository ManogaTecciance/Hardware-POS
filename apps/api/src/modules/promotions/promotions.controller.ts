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
 * D45 — Promotions module.
 *
 * Superseded by D103 on the gate only. This originally read "gated on
 * INVENTORY … INVENTORY is the one module that BOTH Restaurant and Retail
 * tenants carry by default", which was mistaken — food service has no
 * `INVENTORY` — while correctly predicting that a food-service-only module
 * "would refuse Retail's later use of promotions". Both halves are now moot:
 * the gate is `PROMOTIONS`, which both templates carry.
 */
@Controller('promotions')
/*
 * D103 — gated on its OWN key.
 *
 * The docblock above was right that `MENU_MANAGEMENT` would refuse retail, and
 * the D45 hotfix was right that food service lacks `INVENTORY`. Both are true:
 * no module common to the two templates governs a catalogue admin surface, so
 * every choice among the existing keys refuses one of them. The hotfix fixed
 * food service and produced "Feature not available" on a retail Promotions
 * screen — found by walking the UI after Phase 4 had built the engine behind it.
 *
 * `PROMOTIONS` is carried by RETAIL_MODULES and FOOD_SERVICE_MODULES alike, and
 * a gate that names the surface it protects needs no comment explaining why it
 * names something else.
 */
@RequireModule(ModuleKey.PROMOTIONS)
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
