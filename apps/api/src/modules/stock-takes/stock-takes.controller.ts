import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ModuleKey } from '@hardware-pos/database';

import { BranchScope, BranchScopeKind } from '../../common/decorators/branch-scope.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequireModule } from '../../common/decorators/require-module.decorator';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { AuthenticatedUser } from '../auth/auth.types';
import { Permission } from '../auth/permissions';
import { CreateStockTakeDto } from './dto/create-stock-take.dto';
import { StockTakesService, type StockTakeView } from './stock-takes.service';

/**
 * Stock takes / cycle counts — D132 (`8.7`).
 *
 * `INVENTORY`-gated, like receiving: both are inventory operations, and a tenant
 * without the module has no stock to count.
 *
 * `PRODUCT_MANAGE` rather than a new permission. It is the permission that
 * already authorises writing stock quantities — the bulk product import does
 * exactly that — and it is held by Owner, Admin and Manager, which is the set a
 * count needs. D132 records that a dedicated `inventory:count` is the natural
 * next step if a tenant wants a floor manager who counts but cannot edit the
 * catalogue; minting one now would add vocabulary nobody has asked for.
 *
 * The POST is `BRANCH_SCOPED`: a count is of one branch's shelf. The reads are
 * tenant-scoped so a manager can see every branch's count history.
 */
@Controller('stock-takes')
@RequireModule(ModuleKey.INVENTORY)
export class StockTakesController {
  constructor(private readonly service: StockTakesService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions(Permission.PRODUCT_MANAGE)
  @BranchScope(BranchScopeKind.BRANCH_SCOPED)
  create(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateStockTakeDto,
  ): Promise<StockTakeView> {
    return this.service.create(tenantId, user.id, dto);
  }

  @Get()
  @RequirePermissions(Permission.PRODUCT_READ)
  list(@TenantId() tenantId: string): Promise<StockTakeView[]> {
    return this.service.list(tenantId);
  }

  @Get(':id')
  @RequirePermissions(Permission.PRODUCT_READ)
  getById(@TenantId() tenantId: string, @Param('id') id: string): Promise<StockTakeView> {
    return this.service.getById(tenantId, id);
  }
}
