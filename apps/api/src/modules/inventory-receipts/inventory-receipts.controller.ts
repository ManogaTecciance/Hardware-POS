import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ModuleKey } from '@hardware-pos/database';

import { BranchScope, BranchScopeKind } from '../../common/decorators/branch-scope.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequireModule } from '../../common/decorators/require-module.decorator';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { AuthenticatedUser } from '../auth/auth.types';
import { Permission } from '../auth/permissions';
import { CreateReceiptDto } from './dto/create-receipt.dto';
import { QueryReceiptsDto } from './dto/query-receipts.dto';
import {
  InventoryReceiptsService,
  ReceiptResponse,
} from './inventory-receipts.service';

/**
 * Purchase Receipt (Receive Stock / GRN) endpoints — D44.
 *
 * The POST endpoint is `BRANCH_SCOPED` because it targets a specific branch's
 * inventory; the read endpoints stay tenant-scoped so a manager can see every
 * branch's receive history from any active branch context.
 */
@Controller('inventory-receipts')
@RequireModule(ModuleKey.INVENTORY)
export class InventoryReceiptsController {
  constructor(private readonly service: InventoryReceiptsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions(Permission.INVENTORY_RECEIVE)
  @BranchScope(BranchScopeKind.BRANCH_SCOPED)
  create(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateReceiptDto,
  ): Promise<ReceiptResponse> {
    return this.service.createReceipt(tenantId, user.id, dto);
  }

  @Get()
  @RequirePermissions(Permission.PRODUCT_READ)
  list(
    @TenantId() tenantId: string,
    @Query() query: QueryReceiptsDto,
  ) {
    return this.service.listReceipts(tenantId, query);
  }

  @Get(':id')
  @RequirePermissions(Permission.PRODUCT_READ)
  get(
    @TenantId() tenantId: string,
    @Param('id') id: string,
  ): Promise<ReceiptResponse> {
    return this.service.getReceipt(tenantId, id);
  }
}
