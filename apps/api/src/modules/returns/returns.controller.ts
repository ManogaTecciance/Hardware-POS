import { ModuleKey } from '@hardware-pos/database';
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import type { Paginated } from '@hardware-pos/shared';

import { RequireModule } from '../../common/decorators/require-module.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { AuthenticatedUser } from '../auth/auth.types';
import { Permission } from '../auth/permissions';
import { ReturnWithRelations } from './returns.repository';
import { ReturnsService } from './returns.service';
import { ReturnApprovalResult, ReturnListItem, ReturnPreview } from './returns.types';
import { ApproveReturnDto } from './dto/approve-return.dto';
import { CreateReturnDto } from './dto/create-return.dto';
import { PreviewReturnDto } from './dto/preview-return.dto';
import { QueryReturnsDto } from './dto/query-returns.dto';

@Controller('returns')
// Slice 7.6 — retail-only. Legacy tenants enable RETURNS, so Tile Shop is unaffected.
@RequireModule(ModuleKey.RETURNS)
export class ReturnsController {
  constructor(private readonly returnsService: ReturnsService) {}

  /** Recompute the refund breakdown + approval requirement for a selection. */
  @Post('preview')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.RETURN_CREATE)
  preview(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: PreviewReturnDto,
  ): Promise<ReturnPreview> {
    return this.returnsService.preview(tenantId, user, dto);
  }

  /** A cashier submits a manager PIN to authorise a high-risk return. */
  @Post('approve')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.RETURN_CREATE)
  approve(
    @TenantId() tenantId: string,
    @Body() dto: ApproveReturnDto,
  ): Promise<ReturnApprovalResult> {
    return this.returnsService.approve(tenantId, dto);
  }

  /** Complete a return atomically (the whole creation transaction). */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions(Permission.RETURN_CREATE)
  create(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateReturnDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<ReturnWithRelations> {
    return this.returnsService.complete(tenantId, user, dto, idempotencyKey ?? null);
  }

  @Get()
  @RequirePermissions(Permission.RETURN_READ)
  list(
    @TenantId() tenantId: string,
    @Query() query: QueryReturnsDto,
  ): Promise<Paginated<ReturnListItem>> {
    return this.returnsService.list(tenantId, query);
  }

  @Get(':id')
  @RequirePermissions(Permission.RETURN_READ)
  getById(@TenantId() tenantId: string, @Param('id') id: string): Promise<ReturnWithRelations> {
    return this.returnsService.getById(tenantId, id);
  }

  /** Generate (or reprint) the return receipt; returns the print job id + HTML. */
  @Post(':id/receipt')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions(Permission.RETURN_READ)
  receipt(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<{ printJobId: string; html: string }> {
    return this.returnsService.generateReceipt(tenantId, id, user.id);
  }

  /** Manual retry of a failed / pending QuickBooks return sync. */
  @Post(':id/retry-sync')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequirePermissions(Permission.RETURN_READ)
  retrySync(
    @TenantId() tenantId: string,
    @Param('id') id: string,
  ): Promise<{ id: string; syncStatus: string }> {
    return this.returnsService.retrySync(tenantId, id);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.RETURN_CREATE)
  cancel(@TenantId() tenantId: string, @Param('id') id: string): Promise<ReturnWithRelations> {
    return this.returnsService.cancel(tenantId, id);
  }
}
